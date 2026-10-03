import { useEffect, useRef, useState } from 'react';
import { autocomplete } from '../services/interactionService';
import { buildOptions } from '../utils/commandOptions';

const DELAY_MS = 250;

// Suggestions for the autocomplete option `focused` of command `entry` while its value is
// typed (`values`): asked of the bot (interactionService.autocomplete) once typing pauses for
// 250 ms, with the other options as filled in so far. Resolves stale answers away.
// Returns { choices, loading }.
export function useCommandAutocomplete(channelId, entry, values, focused) {
  const [state, setState] = useState({ choices: [], loading: false });
  const asked = useRef(0);
  const typed = focused ? values[focused] ?? '' : null;
  const others = JSON.stringify(values);

  useEffect(() => {
    if (!focused || !entry) {
      setState({ choices: [], loading: false });
      return undefined;
    }
    const id = ++asked.current;
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      const { options } = buildOptions(entry, values, { focused });
      autocomplete(channelId, entry.command.id, options)
        .then((choices) => { if (asked.current === id) setState({ choices, loading: false }); })
        .catch(() => { if (asked.current === id) setState({ choices: [], loading: false }); });
    }, DELAY_MS);
    return () => clearTimeout(timer);
    // `values` is read through `others` (its contents), not its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, entry, focused, typed, others]);

  return state;
}
