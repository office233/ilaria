import { useEffect, useState } from 'react';
export function useRemote<T>(read: (signal: AbortSignal) => Promise<T>) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let mounted = true;

    read(controller.signal).then(result => { if (mounted) setValue(result); }).catch(() => { if (mounted) setError('Conexiunea nu a reușit. Verifică internetul și încearcă din nou.'); }).finally(() => { clearTimeout(timer); if (mounted) setBusy(false); });
    return () => { mounted = false; clearTimeout(timer); controller.abort(); };
  }, [read, revision]);
  return { value, error, busy, retry: () => { setBusy(true); setError(''); setRevision(n => n + 1); } };
}

