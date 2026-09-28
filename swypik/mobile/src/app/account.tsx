import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, s } from '../components/theme';
import { useAuth } from '../features/auth/AuthProvider';

const roleNames = { shopper: 'Cumpărător', creator: 'Creator', seller: 'Comerciant', admin: 'Administrator' };

export default function AccountScreen() {
  const { config, state, controller } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const busy = state.status === 'loading';
  useFocusEffect(useCallback(() => () => { setPassword(''); }, []));

  async function signIn() {
    if (busy || !config.enabled) return;
    const submittedPassword = password;
    setPassword('');
    await controller.signIn(email, submittedPassword);
  }

  return <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      <Text style={s.eyebrow}>CONTUL TĂU</Text>
      <Text style={s.title}>{state.user?.displayName ? `Salut, ${state.user.displayName}!` : 'Locul tău în Swypik.'}</Text>
      <Text style={s.body}>Descoperă, salvează și revino la ce îți place. Începem cu o sesiune sigură, pe dispozitivul tău.</Text>

      {!config.enabled ? <View style={s.card}>
        <Text style={styles.badge}>PILOT · ÎN PREGĂTIRE</Text>
        <Text style={s.heading}>Mai întâi, conexiunea potrivită.</Text>
        <Text style={s.body}>{config.reason}</Text>
        <Text style={s.body}>Poți explora în continuare Descoperă și Magazin. Nu îți cerem parola înainte ca autentificarea să fie disponibilă.</Text>
      </View> : <>
        {busy && <View style={styles.loading} accessibilityLiveRegion="polite">
          <ActivityIndicator color={colors.brand} accessibilityLabel="Se verifică sesiunea" />
          <Text style={s.body}>Se verifică sesiunea…</Text>
        </View>}
        {state.message && <Text accessibilityRole="alert" accessibilityLiveRegion="polite"
          style={state.status === 'error' || state.status === 'offline' ? s.error : s.body}>{state.message}</Text>}

        {state.user ? <View style={s.card}>
          <Text style={styles.badge}>SESIUNE VALIDATĂ</Text>
          <Text style={s.heading}>{state.user.displayName || 'Cont Swypik'}</Text>
          <Text style={s.body}>{state.user.email || 'Email indisponibil'}</Text>
          <Text style={s.body}>{roleNames[state.user.role]}</Text>
          <Text style={styles.note}>Rolul este citit de pe server. Panourile dedicate nu sunt încă incluse în acest pilot.</Text>
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy}
            style={[s.button, busy && styles.disabled]} onPress={() => { void controller.refresh(); }}>
            <Text style={s.buttonText}>Reînnoiește sesiunea</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy}
            style={[styles.secondary, busy && styles.disabled]} onPress={() => { void controller.signOut(); }}>
            <Text style={styles.secondaryText}>Deconectează-te</Text>
          </Pressable>
        </View> : state.status === 'offline' ? <View style={s.card}>
          <Text style={s.heading}>Reconectează-te la internet.</Text>
          <Text style={s.body}>Sesiunea este păstrată securizat. Profilul apare doar după o nouă verificare cu serverul.</Text>
          <Pressable accessibilityRole="button" style={s.button} onPress={() => { void controller.restore(); }}>
            <Text style={s.buttonText}>Încearcă din nou</Text>
          </Pressable>
          <Pressable accessibilityRole="button" style={styles.secondary} onPress={() => { void controller.signOut(); }}>
            <Text style={styles.secondaryText}>Elimină sesiunea de pe dispozitiv</Text>
          </Pressable>
        </View> : <View style={s.card}>
          <Text style={s.heading}>Bine ai revenit.</Text>
          <Text style={s.body}>Folosește un cont existent. Înregistrarea și conectarea prin email nu sunt încă incluse în pilot.</Text>
          <Text style={styles.label}>Email</Text>
          <TextInput accessibilityLabel="Adresa de email" style={styles.input} value={email} onChangeText={setEmail}
            editable={!busy} autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
            autoComplete="email" textContentType="emailAddress" maxLength={254} placeholder="Emailul contului tău" />
          <Text style={styles.label}>Parolă</Text>
          <TextInput accessibilityLabel="Parola contului" style={styles.input} value={password} onChangeText={setPassword}
            editable={!busy} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="password"
            textContentType="password" maxLength={200} returnKeyType="go" onSubmitEditing={() => { void signIn(); }} />
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || !email.trim() || password.length < 8 }}
            disabled={busy || !email.trim() || password.length < 8}
            style={[s.button, (busy || !email.trim() || password.length < 8) && styles.disabled]}
            onPress={() => { void signIn(); }}><Text style={s.buttonText}>Conectează-te</Text></Pressable>
          <Text style={styles.note}>Parola nu este salvată. Sesiunea este păstrată în stocarea securizată a telefonului.</Text>
        </View>}
      </>}
      <Text style={styles.note}>Pilot mobil · Funcțiile sunt adăugate și verificate pe rând. Nu este încă o versiune de lansare.</Text>
    </ScrollView>
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({
  badge: { color: colors.brand, fontSize: 11, fontWeight: '800', letterSpacing: 1.4 },
  label: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  input: { borderWidth: 1, borderColor: '#d4d4d8', borderRadius: 14, padding: 15, color: colors.ink, fontSize: 16, backgroundColor: colors.canvas },
  note: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  disabled: { opacity: 0.45 },
  secondary: { padding: 16, borderRadius: 16, borderWidth: 1, borderColor: '#d4d4d8', alignItems: 'center' },
  secondaryText: { color: colors.brand, fontSize: 16, fontWeight: '700' },
});
