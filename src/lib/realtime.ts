import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

export type InvalidationKind = 'invalidate' | 'access_changed';

function privateChannel(client: SupabaseClient, topic: string, event: string, expectedKind: InvalidationKind, onMessage: () => void) {
  return client.channel(topic, { config: { private: true } })
    .on('broadcast', { event }, (message) => {
      const payload = message.payload as { kind?: unknown } | undefined;
      if (payload?.kind === expectedKind) onMessage();
    });
}

export function petInvalidationChannel(client: SupabaseClient, petId: string, onInvalidate: () => void): RealtimeChannel {
  return privateChannel(client, `hanilog.pet.${petId}`, 'invalidate', 'invalidate', onInvalidate);
}

export function householdInvalidationChannel(client: SupabaseClient, householdId: string, onInvalidate: () => void): RealtimeChannel {
  return privateChannel(client, `hanilog.household.${householdId}`, 'invalidate', 'invalidate', onInvalidate);
}

export function userAccessChannel(client: SupabaseClient, userId: string, onAccessChanged: () => void): RealtimeChannel {
  return privateChannel(client, `hanilog.user.${userId}`, 'access_changed', 'access_changed', onAccessChanged);
}
