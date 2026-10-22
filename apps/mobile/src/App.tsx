import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import {
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SocketProvider, useSocketState, useSubscription } from 'steady-socket/react';
import { api, createDemoSocket, SERVER, type DemoSocket, type Incoming } from './socket';

interface LogEntry {
  id: number;
  at: number;
  text: string;
}

const STATE_COLORS = {
  idle: '#8b949e',
  connecting: '#d29922',
  open: '#2ea043',
  reconnecting: '#d29922',
  closed: '#f85149',
} as const;

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false });

export function App() {
  const dark = useColorScheme() === 'dark';
  const colors = dark ? DARK : LIGHT;

  // Bumping this makes a brand new socket. A closed socket is finished for good (by design), so
  // "sign in again" after an auth failure means a new one.
  const [session, setSession] = useState(1);
  const [socket, setSocket] = useState<DemoSocket | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);

  const note = useCallback((text: string) => {
    setLog((entries) => [
      ...entries.slice(-9),
      { id: (entries.at(-1)?.id ?? 0) + 1, at: Date.now(), text },
    ]);
  }, []);

  useEffect(() => {
    // Create, connect and close the socket together, in one effect (see apps/web/app/demo.tsx).
    const created = createDemoSocket();
    const stopLogging = created.onState((state) => {
      note(created.closeReason ? `${state} (${created.closeReason})` : state);
    });
    // The log also shows when the app moves to the background and back, which is when the
    // `appStateLifecycle` adapter acts.
    const appState = AppState.addEventListener('change', (state) => {
      note(`app: ${state}`);
    });
    created.connect();
    setSocket(created);
    return () => {
      appState.remove();
      stopLogging();
      created.close();
    };
  }, [session, note]);

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]}>
      <StatusBar style={dark ? 'light' : 'dark'} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.title, { color: colors.text }]}>steady-socket</Text>
        <Text style={[styles.muted, { color: colors.muted }]}>
          Talking to {SERVER}. Try airplane mode, or send the app to the background and come back.
        </Text>
        {socket ? (
          <SocketProvider socket={socket}>
            <Connection colors={colors} />
            <MatchScore colors={colors} />
            <Controls
              colors={colors}
              note={note}
              onSignInAgain={() => {
                setSession((n) => n + 1);
              }}
            />
            <Card colors={colors} title="State changes">
              {log.map((entry) => (
                <Text key={entry.id} style={[styles.logLine, { color: colors.text }]}>
                  <Text style={{ color: colors.muted }}>{time(entry.at)} </Text>
                  {entry.text}
                </Text>
              ))}
            </Card>
          </SocketProvider>
        ) : (
          <Text style={{ color: colors.muted }}>starting…</Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Connection({ colors }: { colors: Palette }) {
  const state = useSocketState();
  return (
    <Card colors={colors} title="Connection">
      <View style={styles.row}>
        <View style={[styles.dot, { backgroundColor: STATE_COLORS[state] }]} />
        <Text style={[styles.state, { color: colors.text }]}>{state}</Text>
      </View>
    </Card>
  );
}

function MatchScore({ colors }: { colors: Palette }) {
  const [score, setScore] = useState<number>();

  // The topic is subscribed on mount and again, by the library, after every reconnect.
  useSubscription<Incoming>('match:42', (message) => {
    if (message.type === 'event') setScore(message.payload.score);
  });

  return (
    <Card colors={colors} title="Match 42 score">
      <Text style={[styles.big, { color: colors.text }]}>{score ?? '–'}</Text>
    </Card>
  );
}

function Controls({
  colors,
  note,
  onSignInAgain,
}: {
  colors: Palette;
  note: (text: string) => void;
  onSignInAgain: () => void;
}) {
  const state = useSocketState();

  const call = (path: string, label: string) => () => {
    note(`you: ${label}`);
    fetch(api(path), { method: 'POST' }).catch(() => {
      note('the demo server is not reachable');
    });
  };

  return (
    <Card colors={colors} title="Break it">
      <Button
        colors={colors}
        label="Go silent (dead connection)"
        onPress={call('/control/silent', 'server goes silent')}
      />
      <Button
        colors={colors}
        label="Answer again"
        onPress={call('/control/silent?on=false', 'server answers again')}
      />
      <Button
        colors={colors}
        label="Restart server (5 s)"
        onPress={call('/control/restart?downMs=5000', 'server restarts, 5 s')}
      />
      <Button
        colors={colors}
        label="Expire tokens"
        onPress={call('/control/expire-token', 'tokens expire')}
      />
      {state === 'closed' && (
        <Button colors={colors} label="Sign in again" primary onPress={onSignInAgain} />
      )}
    </Card>
  );
}

function Card({
  colors,
  title,
  children,
}: {
  colors: Palette;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.cardTitle, { color: colors.muted }]}>{title.toUpperCase()}</Text>
      {children}
    </View>
  );
}

function Button({
  colors,
  label,
  onPress,
  primary = false,
}: {
  colors: Palette;
  label: string;
  onPress: () => void;
  primary?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { borderColor: colors.border, backgroundColor: primary ? colors.accent : colors.card },
        pressed && styles.pressed,
      ]}
    >
      <Text style={{ color: primary ? '#fff' : colors.text }}>{label}</Text>
    </Pressable>
  );
}

interface Palette {
  background: string;
  card: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
}
const LIGHT: Palette = {
  background: '#f6f8fa',
  card: '#ffffff',
  border: '#d0d7de',
  text: '#1f2328',
  muted: '#656d76',
  accent: '#0969da',
};
const DARK: Palette = {
  background: '#0d1117',
  card: '#161b22',
  border: '#30363d',
  text: '#e6edf3',
  muted: '#8b949e',
  accent: '#1f6feb',
};

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 16, gap: 12 },
  title: { fontSize: 24, fontWeight: '700' },
  muted: { fontSize: 13 },
  card: { borderWidth: 1, borderRadius: 10, padding: 14, gap: 8 },
  cardTitle: { fontSize: 11, fontWeight: '600', letterSpacing: 0.8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 12, height: 12, borderRadius: 6 },
  state: { fontSize: 20, fontWeight: '600' },
  big: { fontSize: 44, fontWeight: '700', fontVariant: ['tabular-nums'] },
  button: { borderWidth: 1, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12 },
  pressed: { opacity: 0.6 },
  logLine: { fontSize: 12, fontVariant: ['tabular-nums'] },
});
