import { useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Clip } from '../../components/Clip';
import { s } from '../../components/theme';
export default function Studio() {
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function pick() {
    setError(''); setBusy(true);
    try {
      if (Platform.OS === 'ios') {
        const access = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!access.granted) { setError('Permite accesul la galerie din setările telefonului pentru a alege un clip.'); return; }
      }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['videos'], allowsEditing: false });
      if (!result.canceled && result.assets[0]) setUri(result.assets[0].uri);
    } catch { setError('Clipul nu a putut fi deschis. Încearcă alt videoclip.'); }
    finally { setBusy(false); }
  }
  return <ScrollView style={s.screen} contentContainerStyle={s.content}><Text style={s.eyebrow}>STUDIO • TEST LOCAL</Text><Text style={s.title}>Povestea începe cu tine.</Text><Text style={s.body}>Alege un videoclip și verifică redarea pe telefon. Clipul rămâne pe dispozitiv și nu se publică.</Text>
    {uri ? <Clip key={uri} uri={uri} /> : <View style={s.card}><Text style={s.heading}>Un clip. Prima impresie.</Text><Text style={s.body}>Testează imaginea, sunetul, pauza și revenirea în aplicație.</Text></View>}
    {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
    <Pressable accessibilityRole="button" disabled={busy} style={[s.button, busy && {opacity: .5}]} onPress={pick}><Text style={s.buttonText}>{busy ? 'Se deschide galeria…' : 'Alege un videoclip'}</Text></Pressable>
    {uri && <Pressable accessibilityRole="button" style={s.button} onPress={() => setUri(null)}><Text style={s.buttonText}>Închide previzualizarea</Text></Pressable>}
  </ScrollView>;
}

