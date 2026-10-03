import { Text, View, Switch } from 'react-native';
import { s } from '../../components/theme';
import { contributionAvailability } from './client';

export function ContributionPanel() {
  return <View style={s.card}>
    <Text style={s.heading}>Contribuții la Ilaria</Text>
    <Text style={s.body}>Datele și calculul au acorduri separate. Ambele sunt oprite. Întrebările și clipurile tale nu sunt donate pentru antrenare.</Text>
    <View accessibilityLabel="Contribuție cu date, oprită și indisponibilă">
      <Text style={s.body}>Date aprobate pentru antrenare</Text>
      <Switch value={false} disabled accessibilityLabel="Acord date: indisponibil" />
    </View>
    <View accessibilityLabel="Contribuție cu calcul, oprită în așteptarea executorului">
      <Text style={s.body}>Calcul pentru sarcini semnate</Text>
      <Switch value={false} disabled accessibilityLabel="Acord calcul: executor indisponibil" />
    </View>
    <Text style={s.body}>{contributionAvailability.compute === 'awaiting-release'
      ? 'Executorul de rețea nu are încă handoff acceptat. Calculul pe telefon nu este disponibil; nu rulează antrenare.'
      : 'Nu există executor de contribuții disponibil.'}</Text>
  </View>;
}
