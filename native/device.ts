import { Alert, Linking } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Crypto from 'expo-crypto';
import * as IntentLauncher from 'expo-intent-launcher';
import { MAX_FILE, safeFilename, text } from './vault';

const exportDir = `${FileSystem.cacheDirectory}heritage-exports/`;
const exportsInProgress = new Map<string, { name: string; chunks: string[]; length: number }>();
export async function viewEvidence(value: unknown) {
  if (!value || typeof value !== 'object') throw new Error('Invalid evidence.');
  const record = value as { fileData?: string; fileName?: string; fileType?: string };
  const name = safeFilename(record.fileName);
  if (typeof record.fileData !== 'string' || record.fileData.length > MAX_FILE * 1.4 ||
    !/^data:[^,]*;base64,[A-Za-z0-9+/]*={0,2}$/.test(record.fileData)) throw new Error('Evidence is missing or unreadable.');
  const directory = exportDir + Crypto.randomUUID() + '/';
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const uri = directory + name;
  await FileSystem.writeAsStringAsync(uri, record.fileData.split(',')[1], { encoding: FileSystem.EncodingType.Base64 });
  try {
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: await FileSystem.getContentUriAsync(uri),
      type: record.fileType || 'application/octet-stream', flags: 1
    });
  } catch {
    throw new Error('No app could open this evidence file. Export the evidence ZIP to view it with a compatible viewer.');
  }
}
export async function clearTemporaryFiles() {
  const exportsExist = await FileSystem.getInfoAsync(exportDir);
  if (exportsExist.exists) {
    for (const name of await FileSystem.readDirectoryAsync(exportDir)) {
      const uri = exportDir + name;
      const info = await FileSystem.getInfoAsync(uri);
      if (info.exists && info.modificationTime < Date.now() / 1000 - 86400) {
        await FileSystem.deleteAsync(uri, { idempotent: true });
      }
    }
  }
  // These caches belong to this application, never the user's source documents.
  for (const uri of [`${FileSystem.cacheDirectory}DocumentPicker/`, `${FileSystem.cacheDirectory}ImagePicker/`]) {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  }
  exportsInProgress.clear();
}
async function readPicked(uri: string, name: string, type: string, ownedCache: boolean) {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists || !('size' in info) || info.size > MAX_FILE) throw new Error('Choose a file of 10 MB or smaller.');
    return { name: safeFilename(name), type, base64: await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 }) };
  } finally {
    if (ownedCache && uri.startsWith(FileSystem.cacheDirectory!)) {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    }
  }
}
export async function pickEvidence() {
  const choice = await new Promise<'camera' | 'file' | null>(resolve => {
    Alert.alert('Add evidence', 'Take a photograph or choose an existing file.', [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
      { text: 'Choose file', onPress: () => resolve('file') },
      { text: 'Camera', onPress: () => resolve('camera') },
    ], { cancelable: true, onDismiss: () => resolve(null) });
  });
  if (!choice) return [];
  if (choice === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      if (!permission.canAskAgain) Alert.alert('Camera access is disabled', 'Allow camera access in Android settings, or choose an existing file.', [
        { text: 'Close' }, { text: 'Open settings', onPress: () => { void Linking.openSettings(); } },
      ]);
      throw new Error('Camera permission was not granted. You can choose an existing file instead.');
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1, exif: false, allowsEditing: false });
    if (result.canceled) return [];
    const asset = result.assets[0];
    return [await readPicked(asset.uri, asset.fileName || `photo_${Date.now()}.jpg`, asset.mimeType || 'image/jpeg', true)];
  }
  const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: '*/*' });
  if (result.canceled) return [];
  if (result.assets.reduce((total, asset) => total + (asset.size ?? MAX_FILE), 0) > 60 * 1024 * 1024) {
    throw new Error('Choose at most 60 MB of evidence at a time.');
  }
  const files = [];
  for (const asset of result.assets) {
    files.push(await readPicked(asset.uri, asset.name, asset.mimeType || 'application/octet-stream', true));
  }
  return files;
}
export async function exportCall(method: string, args: unknown[]) {
  if (method === 'exportBegin') {
    const name = safeFilename(args[0]);
    if (!/\.(zip|xlsx)$/.test(name)) throw new Error('Unsupported export format.');
    if (exportsInProgress.size) throw new Error('Finish the current export first.');
    const id = Crypto.randomUUID();
    exportsInProgress.set(id, { name, chunks: [], length: 0 });
    return id;
  }
  const id = text(args[0], 100);
  const entry = exportsInProgress.get(id);
  if (!entry) throw new Error('Export session expired. Please try again.');
  if (method === 'exportCancel') { exportsInProgress.delete(id); return true; }
  if (method === 'exportChunk') {
    const chunk = text(args[1], 262144);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(chunk) || chunk.length % 4) throw new Error('Invalid export chunk.');
    entry.length += chunk.length;
    if (entry.length > 140 * 1024 * 1024) { exportsInProgress.delete(id); throw new Error('Export is too large.'); }
    entry.chunks.push(chunk);
    return true;
  }
  if (method !== 'exportFinish') throw new Error('Unsupported export operation.');
  const directory = exportDir + id + '/';
  const uri = directory + entry.name;
  try {
    const action = await new Promise<'save' | 'share' | null>(resolve => {
      Alert.alert('Survey export', 'Save a permanent copy to device storage, or share a temporary copy.', [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
        { text: 'Save to device storage', onPress: () => resolve('save') },
        { text: 'Share', onPress: () => resolve('share') },
      ], { cancelable: true, onDismiss: () => resolve(null) });
    });
    if (!action) throw new Error('Export cancelled. No file was saved.');
    const mimeType = entry.name.endsWith('.zip') ? 'application/zip' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (action === 'save') {
      const permission = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (!permission.granted) throw new Error('Save cancelled. No device folder was selected.');
      let destination: string | undefined;
      try {
        destination = await FileSystem.StorageAccessFramework.createFileAsync(permission.directoryUri, entry.name, mimeType);
        await FileSystem.StorageAccessFramework.writeAsStringAsync(destination, entry.chunks.join(''), { encoding: FileSystem.EncodingType.Base64 });
      } catch {
        if (destination) await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => {});
        throw new Error('Could not write the export to device storage. Check available space and folder access, then retry.');
      }
      return { action: 'saved' };
    }
    if (!(await Sharing.isAvailableAsync())) throw new Error('Android sharing is unavailable.');
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    await FileSystem.writeAsStringAsync(uri, entry.chunks.join(''), { encoding: FileSystem.EncodingType.Base64 });
    await Sharing.shareAsync(uri, { mimeType, dialogTitle: 'Share survey export' });
    return { action: 'shared' };
  } finally {
    exportsInProgress.delete(id);
    // Android recipients may read the content URI after the chooser returns.
    // Keep the temporary copy until a later startup (at least 24 hours).
  }
}
