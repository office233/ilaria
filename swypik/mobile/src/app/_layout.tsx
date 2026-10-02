import { Tabs } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Text } from 'react-native';
import { colors } from '../components/theme';
import { AuthProvider } from '../features/auth/AuthProvider';

export default function Layout() {
  return <AuthProvider><StatusBar style="dark" /><Tabs screenOptions={{ headerTitle: 'swypik', headerTitleStyle: { color: colors.brand, fontWeight: '800', fontSize: 28 }, tabBarActiveTintColor: colors.brand, tabBarStyle: { backgroundColor: '#fff' } }}>
    <Tabs.Screen name="index" options={{ title: 'Descoperă', tabBarIcon: ({color}) => <Text style={{color, fontSize: 22}}>◉</Text> }} />
    <Tabs.Screen name="shop" options={{ title: 'Magazin', tabBarIcon: ({color}) => <Text style={{color, fontSize: 22}}>◇</Text> }} />
    <Tabs.Screen name="ilaria" options={{ title: 'Ilaria', tabBarIcon: ({color}) => <Text style={{color, fontSize: 22}}>✦</Text> }} />
    <Tabs.Screen name="account" options={{ title: 'Cont', tabBarIcon: ({color}) => <Text style={{color, fontSize: 22}}>○</Text> }} />
  </Tabs></AuthProvider>;
}
