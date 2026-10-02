import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { AuthController } from '../../lib/auth-core';
import { IlariaClient, type IlariaState } from '../../lib/ilaria-api';

export function useIlaria(auth: AuthController) {
  const [state, setState] = useState<IlariaState>({ status: 'idle', response: null, message: '' });
  const current = useRef<IlariaClient | null>(null);
  useEffect(() => {
    const client = new IlariaClient(auth, setState);
    current.current = client;
    client.setForeground(AppState.currentState === 'active');
    const change = AppState.addEventListener('change', value => client.setForeground(value === 'active'));
    const blur = AppState.addEventListener('blur', () => client.setForeground(false));
    const focus = AppState.addEventListener('focus', () => client.setForeground(AppState.currentState === 'active'));
    const memory = AppState.addEventListener('memoryWarning', () => { void client.cancel('user'); });
    return () => {
      change.remove(); blur.remove(); focus.remove(); memory.remove(); client.close();
      if (current.current === client) current.current = null;
    };
  }, [auth]);
  const start = useCallback((goal: string) => current.current?.start(goal) ?? Promise.resolve(), []);
  const cancel = useCallback(() => current.current?.cancel() ?? Promise.resolve(), []);
  const setRemoteConsent = useCallback((value: boolean) => current.current?.setRemoteConsent(value), []);
  return { state, start, cancel, setRemoteConsent };
}
