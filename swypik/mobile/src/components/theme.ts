import { StyleSheet } from 'react-native';
export const colors = { brand: '#7c3aed', ink: '#0d0d0d', muted: '#52525b', canvas: '#f7f7f8' };
export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas }, content: { padding: 24, gap: 20, width: '100%', maxWidth: 640, alignSelf: 'center', paddingBottom: 40 },
  eyebrow: { color: colors.brand, fontSize: 12, fontWeight: '700', letterSpacing: 2 }, title: { color: colors.ink, fontSize: 34, fontWeight: '800', letterSpacing: -1 },
  body: { color: colors.muted, fontSize: 16, lineHeight: 25 }, card: { backgroundColor: '#fff', borderRadius: 24, padding: 24, gap: 16, borderWidth: 1, borderColor: '#e4e4e7' },
  heading: { color: colors.ink, fontSize: 22, fontWeight: '700' }, button: { backgroundColor: colors.brand, padding: 16, borderRadius: 16, alignItems: 'center' }, buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  error: { color: '#b91c1c', fontSize: 15, lineHeight: 23 }, image: { width: '100%', height: 220, borderRadius: 16 },
});
