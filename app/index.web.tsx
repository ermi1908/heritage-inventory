import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';

export default function AndroidPreviewNotice() {
  const colors = useColors();
  return <View style={[styles.screen, { backgroundColor: colors.background }]}>
    <Text style={[styles.title, { color: colors.foreground }]}>Eritrean National Built Heritage Inventory</Text>
    <Text style={[styles.text, { color: colors.mutedForeground }]}>Android offline edition</Text>
    <Text style={[styles.text, { color: colors.foreground }]}>The survey files are bundled inside the Android app. Local survey storage, camera evidence and file sharing run on the phone, without an app login or internet connection.</Text>
    <Text style={[styles.text, { color: colors.mutedForeground }]}>Your existing web app remains separate and unchanged. A signed APK and installed-device verification are still required before field use.</Text>
  </View>;
}
const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', paddingHorizontal: 28, paddingTop: 67, paddingBottom: 34, gap: 24 },
  title: { fontSize: 25, fontWeight: 'bold', textAlign: 'center' },
  text: { fontSize: 16, lineHeight: 24, textAlign: 'center' },
});
