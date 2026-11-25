import { Alert, Badge, Button, Card, CloseButton, Group, Progress, ScrollArea, Stack, Text, Title, UnstyledButton } from "@mantine/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MonitorApi } from "../main/preload";
import {
  formatRelative, problemNote, PROVIDER_META, resetShort, resetText, stateLabel, usageLevel,
  type PanelSnapshot, type Provider, type ProviderState, type UsageWindow,
} from "../shared/usage";

declare global {
  interface Window { monitor: MonitorApi }
}

const STATE_COLOR: Record<ProviderState, string> = {
  ready: "green",
  connected: "blue",
  snapshot: "yellow",
  blocked: "red",
  unavailable: "gray",
  "signed-out": "orange",
  error: "red",
};

const LEVEL_COLOR = { ok: "green", warn: "yellow", high: "red", none: "gray" } as const;

function UsageRow({ window: usage }: { window: UsageWindow }) {
  const used = Math.round(usage.used);
  return (
    <div title={resetText(usage)}>
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Text size="xs" truncate>
          {usage.label} <Text span c="dimmed" inherit>· {resetShort(usage)}</Text>
        </Text>
        <Text size="xs" fw={700}>{used}%</Text>
      </Group>
      <Progress value={used} color={LEVEL_COLOR[usageLevel(usage.used)]} size="sm" mt={3} aria-label={`${usage.label} usage`} />
    </div>
  );
}

function ProviderCard({ provider }: { provider: Provider }) {
  const meta = PROVIDER_META[provider.id];
  const needsSignIn = provider.id === "claude" && provider.state !== "ready";
  const note = problemNote(provider);
  return (
    <Card withBorder padding="xs">
      <Group wrap="nowrap" gap="xs">
        <UnstyledButton
          onClick={() => window.monitor.openProvider(provider.id)}
          title={`Open the ${meta.name} usage page in your browser`}
          style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}
        >
          <span className="mark" style={{ background: meta.color }}>{meta.mark}</span>
          <Text fw={600} size="sm" truncate>{meta.name}</Text>
        </UnstyledButton>
        {needsSignIn && (
          <Button size="compact-xs" color="orange" onClick={() => window.monitor.signIn()}>Sign in</Button>
        )}
        <Badge color={STATE_COLOR[provider.state]} variant="light" size="sm" title={provider.note ?? undefined}>
          {stateLabel(provider.state)}
        </Badge>
      </Group>
      {provider.windows.length > 0 && (
        <Stack gap={6} mt={8}>
          {provider.windows.map((usage) => <UsageRow key={usage.label} window={usage} />)}
        </Stack>
      )}
      {note && <Text size="xs" c="dimmed" mt={6} lineClamp={2}>{note}</Text>}
    </Card>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<PanelSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);
  const headRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);

  // Ask the window to be exactly as tall as the header plus the cards.
  useEffect(() => {
    const head = headRef.current;
    const cards = cardsRef.current;
    if (!head || !cards) return;
    const report = () => { window.monitor.resize(head.offsetHeight + cards.offsetHeight + 10); };
    const observer = new ResizeObserver(report);
    observer.observe(cards);
    report();
    return () => observer.disconnect();
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    try { setSnapshot(await window.monitor.refresh()); } finally { setBusy(false); }
  }, []);

  useEffect(() => {
    window.monitor.get().then((value) => { if (value) setSnapshot(value); });
    const stop = window.monitor.onUpdate(setSnapshot);
    // Keeps "in 2 hours" style texts current between readings.
    const timer = setInterval(() => setTick((value) => value + 1), 30_000);
    return () => { stop(); clearInterval(timer); };
  }, []);

  return (
    <div className="panel">
      <Group ref={headRef} className="panel-head" justify="space-between" wrap="nowrap">
        <Group gap={8} align="baseline" wrap="nowrap">
          <Title order={6}>AI Monitor</Title>
          <Text size="xs" c="dimmed">{snapshot ? formatRelative(snapshot.updatedAt) : "reading..."}</Text>
        </Group>
        <Group gap={4} wrap="nowrap">
          <Button size="compact-xs" variant="light" loading={busy} onClick={refresh}>Refresh</Button>
          <CloseButton size="sm" aria-label="Hide panel" onClick={() => window.monitor.hide()} />
        </Group>
      </Group>
      <ScrollArea className="panel-body" px={8} pb={8}>
        <Stack ref={cardsRef} gap={8}>
          {snapshot && !snapshot.serviceOnline && (
            <Alert color="red" variant="light" p="xs">
              Background service offline: no Codex or Grok data.
            </Alert>
          )}
          {snapshot?.providers.map((provider) => <ProviderCard key={provider.id} provider={provider} />)}
        </Stack>
      </ScrollArea>
    </div>
  );
}
