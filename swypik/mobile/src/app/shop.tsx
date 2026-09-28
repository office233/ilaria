import { ActivityIndicator, Platform, Image, Pressable, ScrollView, Text, View } from 'react-native';
import { s, colors } from '../components/theme';
import { readApi, parseProducts } from '../lib/api';
import { useRemote } from '../lib/useRemote';
const load = async (signal: AbortSignal) => parseProducts(await readApi('/api/products?mode=video&limit=12', signal, Platform.OS === 'web'));
export default function Shop() {
  const {value, busy, error, retry} = useRemote(load);
  return <ScrollView style={s.screen} contentContainerStyle={s.content}><Text style={s.eyebrow}>MAGAZINUL SWYPIK</Text><Text style={s.title}>Din descoperire, în preferințe.</Text><Text style={s.body}>Catalogul public, în prima sa versiune pentru mobil.</Text>
    {busy ? <ActivityIndicator color={colors.brand} size="large" /> : error ? <Text style={s.error} accessibilityRole="alert">{error}</Text> : value?.products.length ? value.products.map(p => <View key={p.id} style={s.card}>{p.image && <Image source={{uri: p.image}} style={s.image} accessibilityLabel={p.title} />}<Text style={s.heading}>{p.title}</Text><Text style={s.body}>{p.price.toFixed(2)} {value.currency}</Text></View>) : <View style={s.card}><Text style={s.heading}>Catalogul se pregătește.</Text><Text style={s.body}>Nu există produse disponibile în acest catalog. Revino pentru noutăți.</Text></View>}
    <Pressable accessibilityRole="button" style={[s.button, busy && {opacity: .5}]} disabled={busy} onPress={retry}><Text style={s.buttonText}>Reîncarcă produsele</Text></Pressable><Text style={s.body}>Cumpărăturile nu sunt activate în acest prototip.</Text></ScrollView>;
}

