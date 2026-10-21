import React, { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import * as Crypto from 'expo-crypto';
import { useColors } from '@/hooks/useColors';
import { openVault, vaultCall } from '@/native/vault';
import { clearTemporaryFiles, exportCall, pickEvidence, viewEvidence } from '@/native/device';
import survey from '@/assets/survey/bundle.json';

export default function OfflineSurvey() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const web = useRef<WebView>(null);
  const allowed = useRef(false);
  const externalOperation = useRef(false);
  const queue = useRef(Promise.resolve());
  const [session] = useState(() => Crypto.randomUUID().replaceAll('-', ''));
  const [html] = useState(() => survey.html.replaceAll('__BRIDGE_SESSION__', session));
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Opening offline inventory…');

  useEffect(() => {
    void initialize();
    return () => { allowed.current = false; };
  }, []);

  async function initialize() {
    if (busy) return;
    setBusy(true);
    try {
      if (!ready) {
        await clearTemporaryFiles();
        await openVault();
      }
      allowed.current = true;
      setReady(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not open local storage. Saved data has not been reset.');
    } finally { setBusy(false); }
  }
  function reply(id: string, result?: unknown, error?: string) {
    const payload = JSON.stringify({ id, result, error }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    web.current?.injectJavaScript(`window.__nativeReply(${payload});true;`);
  }
  function receive(event: WebViewMessageEvent) {
    const raw = event.nativeEvent.data;
    if (raw.length > 15 * 1024 * 1024) return;
    let request: { id: string; session: string; method: string; args: unknown[] };
    try { request = JSON.parse(raw); } catch { return; }
    if (request.session !== session || !/^\d{1,12}$/.test(request.id) || !Array.isArray(request.args)) return;
    if (!allowed.current || externalOperation.current) { reply(request.id, undefined, 'App is not ready or is busy. Please retry.'); return; }
    queue.current = queue.current.then(async () => {
      if (!allowed.current) { reply(request.id, undefined, 'App is not ready. Please retry.'); return; }
      try {
        let result: unknown;
        if (request.method === 'pickEvidence' || request.method === 'exportFinish' || request.method === 'viewEvidence') {
          externalOperation.current = true;
          try {
            result = request.method === 'pickEvidence' ? await pickEvidence() :
              request.method === 'viewEvidence' ? await viewEvidence(request.args[0]) : await exportCall(request.method, request.args);
          } finally { externalOperation.current = false; }
        } else if (['exportBegin', 'exportChunk', 'exportCancel'].includes(request.method)) {
          result = await exportCall(request.method, request.args);
        } else {
          result = await vaultCall(request.method, request.args);
        }
        reply(request.id, result);
      } catch (error) {
        reply(request.id, undefined, error instanceof Error ? error.message : 'Operation failed.');
      }
    });
  }
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: insets.top, paddingBottom: insets.bottom }}>
      {ready && <View style={{ flex: 1 }}>
        <WebView ref={web} source={{ html, baseUrl: 'https://offline.invalid/' }}
          originWhitelist={['https://offline.invalid', 'about:blank']}
          onShouldStartLoadWithRequest={request => request.url === 'about:blank' || request.url === 'https://offline.invalid/'}
          onMessage={receive} javaScriptEnabled domStorageEnabled={false}
          allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false}
          mixedContentMode="never" cacheEnabled={false} incognito thirdPartyCookiesEnabled={false}
          javaScriptCanOpenWindowsAutomatically={false} setSupportMultipleWindows
          onOpenWindow={() => Alert.alert('Navigation blocked', 'External pages cannot access your survey.')}
          onRenderProcessGone={() => {
            allowed.current = false; setReady(false);
            setMessage('The survey view closed. Saved data is retained; unsaved edits may be lost. Tap Retry to reopen.');
          }}
        />
      </View>}
      {!ready && <View style={[StyleSheet.absoluteFill, styles.loading, { backgroundColor: colors.background, paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
        <Text style={[styles.title, { color: colors.foreground }]}>Eritrean National Built Heritage Inventory</Text>
        <Text style={[styles.body, { color: colors.mutedForeground }]}>{message}</Text>
        <Pressable testID="retry-inventory" disabled={busy} onPress={initialize}
          style={[styles.button, { backgroundColor: colors.primary, opacity: busy ? 0.6 : 1 }]}>
          <Text style={{ color: colors.primaryForeground, fontWeight: 'bold' }}>{busy ? 'Opening…' : 'Retry'}</Text>
        </Pressable>
        <Text style={[styles.body, { color: colors.mutedForeground }]}>Do not uninstall to update. Uninstalling or losing the device can permanently lose local surveys. Keep exports in a trusted location.</Text>
      </View>}
    </View>
  );
}
const styles = StyleSheet.create({
  loading: { justifyContent: 'center', paddingHorizontal: 28, gap: 24 },
  title: { fontSize: 25, fontWeight: 'bold', textAlign: 'center' },
  body: { fontSize: 15, lineHeight: 23, textAlign: 'center' },
  button: { padding: 18, alignItems: 'center', borderRadius: 6 },
});
