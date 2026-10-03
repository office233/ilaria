import { useState } from 'react';
import { Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { s, colors } from '../../components/theme';
import { useAuth } from '../auth/AuthProvider';
import { ContributionPanel } from '../contribution/ContributionPanel';
import { useIlaria } from './useIlaria';
import type { AuthController, AuthConfig } from '../../lib/auth-core';

export function IlariaScreen() {
  const { state: auth, controller, config } = useAuth();
  return <IlariaSessionPanel key={auth.status + ':' + (auth.user?.userId ?? 'anonymous')}
    controller={controller} config={config} authenticated={auth.status === 'authenticated'} />;
}

function IlariaSessionPanel({ controller, config, authenticated }: {
  controller: AuthController; config: AuthConfig; authenticated: boolean;
}) {
  const { state, start, cancel, setRemoteConsent } = useIlaria(controller);
  const [goal, setGoal] = useState('');
  const [remote, setRemote] = useState(false);
  const busy = state.status === 'running' || state.status === 'stopping';
  const ready = config.enabled && authenticated && remote && !busy && goal.trim().length > 0;
  return <ScrollView style={s.screen} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
    <Text style={s.eyebrow}>ILARIA · IMC</Text>
    <Text style={s.title}>Întreabă Ilaria</Text>
    <Text style={s.body}>Cererea merge către gazda Ilaria autenticată. Nu cere instalarea SwypikOS pe telefon și nu autorizează antrenarea cu conversația ta.</Text>
    {!config.enabled && <Text style={s.body}>{config.reason}</Text>}
    <View style={s.card}>
      <Text style={s.body}>Permit trimiterea acestei întrebări către gazda configurată pentru inferență.</Text>
      <Switch accessibilityLabel="Acord pentru inferență la distanță" value={remote}
        disabled={!authenticated} onValueChange={value => { setRemote(value); setRemoteConsent(value); }} />
      <TextInput accessibilityLabel="Întrebarea pentru Ilaria" placeholder="Scrie o întrebare"
        multiline maxLength={4096} value={goal} onChangeText={setGoal} editable={!busy}
        style={{ borderWidth: 1, borderColor: colors.muted, borderRadius: 12, padding: 12, minHeight: 100, color: colors.ink }} />
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: !ready }} disabled={!ready}
        style={[s.button, !ready && { opacity: 0.45 }]} onPress={() => { void start(goal); }}>
        <Text style={s.buttonText}>Trimite către Ilaria</Text>
      </Pressable>
      {busy && <Pressable accessibilityRole="button" style={s.button} onPress={() => { void cancel(); }}>
        <Text style={s.buttonText}>Oprește cererea</Text>
      </Pressable>}
      {!!state.message && <Text accessibilityLiveRegion="polite" style={state.status === 'error' || state.status === 'uncertain' ? s.error : s.body}>{state.message}</Text>}
      {state.response && authenticated && <View>
        <Text selectable style={s.body}>{state.response.hypothesis}</Text>
        <Text style={s.body}>Model: {state.response.expert_version}</Text>
        <Text style={s.body}>Pași forward: {state.response.compute_cost} · energia: nemăsurată</Text>
      </View>}
    </View>
    <ContributionPanel />
  </ScrollView>;
}
