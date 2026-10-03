import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { AuthController } from '../../lib/auth-core';
import { IlariaClient, type IlariaState } from '../../lib/ilaria-api';

export function useIlaria(auth: AuthController) {
  const [state, setState] = useState<IlariaState>({ status: 'idle', response: null, message: '' });
  const current = useRef<IlariaClient | null>(null);
  const routeFocused = useRef(false);
  const appInteractive = useRef(AppState.currentState === 'active');
  useEffect(() => {
    const client = new IlariaClient(auth, setState);
    current.current = client;
    setState(client.getState());
    client.setForeground(routeFocused.current && appInteractive.current);
    const change = AppState.addEventListener('change', value => {
      appInteractive.current = value === 'active';
      client.setForeground(routeFocused.current && appInteractive.current);
    });
    const blur = AppState.addEventListener('blur', () => {
      appInteractive.current = false;
      client.setForeground(false);
    });
    const focus = AppState.addEventListener('focus', () => {
      appInteractive.current = AppState.currentState === 'active';
      client.setForeground(routeFocused.current && appInteractive.current);
    });
    const memory = AppState.addEventListener('memoryWarning', () => { void client.cancel('user'); });
    return () => {
      change.remove(); blur.remove(); focus.remove(); memory.remove(); client.close();
      if (current.current === client) current.current = null;
    };
  }, [auth]);
  useFocusEffect(useCallback(() => {
    routeFocused.current = true;
    current.current?.setForeground(appInteractive.current);
    return () => {
      routeFocused.current = false;
      current.current?.setForeground(false);
    };
  }, []));
  const start = useCallback((goal: string) => current.current?.start(goal) ?? Promise.resolve(), []);
  const cancel = useCallback(() => current.current?.cancel() ?? Promise.resolve(), []);
  const setRemoteConsent = useCallback((value: boolean) => current.current?.setRemoteConsent(value), []);
  return { state, start, cancel, setRemoteConsent };
}
