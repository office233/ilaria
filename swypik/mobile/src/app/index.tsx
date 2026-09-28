import { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from 'react-native';

import { Clip } from '../components/Clip';
import { s, colors } from '../components/theme';
import { readApi, parseFeed } from '../lib/api';
import { useRemote } from '../lib/useRemote';
const load = async (signal: AbortSignal) => parseFeed(await readApi('/api/explore/feed?limit=12', signal, Platform.OS === 'web'));
export default function Discover() {
  const { value, busy, error, retry } = useRemote(load);
  const [index, setIndex] = useState(0);
  const current = value?.[index % (value.length || 1)];
  return <ScrollView style={s.screen} contentContainerStyle={s.content}>
    <Text style={s.eyebrow}>SWYPIK • PREVIZUALIZARE MOBILĂ</Text><Text style={s.title}>Descoperă ce te inspiră.</Text><Text style={s.body}>Creatori, povești și produse, într-un singur loc.</Text>
    {busy ? <ActivityIndicator size="large" color={colors.brand} accessibilityLabel="Se încarcă feedul" /> : error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : current ? <View style={s.card}><Clip key={current.id} uri={current.url} /><Text style={s.heading}>@{current.creator}</Text><Text style={s.body}>{current.description}</Text><Pressable style={s.button} onPress={() => setIndex(n => n + 1)}><Text style={s.buttonText}>Următorul clip</Text></Pressable></View> : <View style={s.card}><Text style={s.heading}>Primele povești urmează.</Text><Text style={s.body}>Feedul public nu conține încă videoclipuri disponibile. Revino pentru primele povești ale creatorilor.</Text></View>}
    <Pressable accessibilityRole="button" disabled={busy} style={[s.button, busy && {opacity: .5}]} onPress={retry}><Text style={s.buttonText}>Reîncarcă feedul</Text></Pressable>
    <Text style={s.body}>Versiune de test. Feedul afișează conținutul public Swypik.</Text>
  </ScrollView>;
}


