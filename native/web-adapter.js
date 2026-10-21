/* Native-only adapter. The browser app continues using its original IndexedDB. */
const pendingNative = new Map();
// The legacy UI logs record objects on errors. Do not send survey data to native logs.
for (const level of ['log', 'info', 'warn', 'error', 'debug']) console[level] = () => {};
let nativeSequence = 0;
const nativeSession = '__BRIDGE_SESSION__';
function nativeCall(method, args = []) {
    const id = String(++nativeSequence);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingNative.delete(id);
            reject(new Error('Native operation timed out. Please retry.'));
        }, 180000);
        pendingNative.set(id, { resolve, reject, timer });
        window.ReactNativeWebView.postMessage(JSON.stringify({ id, session: nativeSession, method, args }));
    });
}
window.__nativeReply = ({ id, result, error }) => {
    const pending = pendingNative.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingNative.delete(id);
    error ? pending.reject(new Error(error)) : pending.resolve(result);
};
const initDB = () => nativeCall('init');
const saveBuilding = (record, previousReference = record.buildingReferenceNumber) => nativeCall('saveBuilding', [record, previousReference]);
const getBuilding = (ref) => nativeCall('getBuilding', [ref]);
const getAllBuildings = () => nativeCall('getAllBuildings');
const deleteBuilding = (ref) => nativeCall('deleteBuilding', [ref]);
const getAttachmentsFlat = (ref) => nativeCall('getAttachmentsFlat', [ref]);
window.__viewSavedEvidence = record => nativeCall('viewEvidence', [record]);
async function searchBuildings(term) {
    const lower = term.toLowerCase();
    return (await getAllBuildings()).filter(record =>
        ['buildingName', 'buildingReferenceNumber', 'heritageZone', 'region']
            .some(key => record[key]?.toLowerCase().includes(lower)));
}
async function getAttachments(ref) {
    const result = Object.create(null);
    for (const attachment of await getAttachmentsFlat(ref)) {
        const section = result[attachment.section] ||= Object.create(null);
        (section[attachment.question] ||= []).push(attachment);
    }
    return result;
}
function blobData(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read file.'));
        reader.readAsDataURL(blob);
    });
}
async function saveAttachment(ref, section, question, file) {
    if (file.size > 10 * 1024 * 1024) throw new Error('Each evidence file must be 10 MB or smaller.');
    return nativeCall('saveAttachment', [{
        buildingReferenceNumber: ref, section, question,
        fileName: file.name, fileType: file.type, fileSize: file.size,
        fileData: await blobData(file), dateAdded: new Date().toISOString()
    }]);
}
async function saveAs(blob, name) {
    if (blob.size > 100 * 1024 * 1024) throw new Error('Export exceeds the 100 MB mobile limit.');
    const data = (await blobData(blob)).split(',')[1];
    const exportId = await nativeCall('exportBegin', [name]);
    try {
        for (let offset = 0; offset < data.length; offset += 262144) {
            await nativeCall('exportChunk', [exportId, data.slice(offset, offset + 262144)]);
        }
        const result = await nativeCall('exportFinish', [exportId]);
        if (result?.action === 'saved') showToast('Export saved to your selected device folder.', 'success');
        else showToast('Share sheet closed. Check your chosen destination; sharing does not confirm a saved copy.', 'info');
    } catch (error) {
        await nativeCall('exportCancel', [exportId]).catch(() => {});
        throw error;
    }
}
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('input[type=file]').forEach(input => {
        input.addEventListener('click', async event => {
            event.preventDefault();
            try {
                const files = await nativeCall('pickEvidence');
                if (!files.length) return;
                const transfer = new DataTransfer();
                for (const picked of files) {
                    const bytes = Uint8Array.from(atob(picked.base64), c => c.charCodeAt(0));
                    transfer.items.add(new File([bytes], picked.name, { type: picked.type }));
                }
                input.files = transfer.files;
                input.dispatchEvent(new Event('change', { bubbles: true }));
            } catch (error) { showToast(error.message, 'error'); }
        });
    });
});
