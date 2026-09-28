import { useEffect } from 'react';
import { AppState, StyleSheet } from 'react-native';
import { useIsFocused } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
export function Clip({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (instance) => { instance.loop = true; });
  const focused = useIsFocused();
  useEffect(() => {
    if (!focused) player.pause();
    const subscription = AppState.addEventListener('change', state => { if (state !== 'active') player.pause(); });
    return () => subscription.remove();
  }, [focused, player]);
  return <VideoView player={player} nativeControls contentFit="contain" style={styles.video} />;
}
const styles = StyleSheet.create({ video: { width: '100%', aspectRatio: 9 / 14, maxHeight: 520, backgroundColor: '#0d0d0d', borderRadius: 20 } });

