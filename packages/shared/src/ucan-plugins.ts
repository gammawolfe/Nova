// packages/shared/src/ucan-plugins.ts
//
// A `@ucans/core` plugin set with the default did:key handlers + Nova's
// did:web method plugin merged in. Exports `novaUcansValidate` and other
// API surfaces that should be used in place of the bare `@ucans/ucans`
// equivalents whenever a UCAN may have a did:web issuer.
//
// Design choices:
//
//   - Lazy initialisation. The plugin needs Nova's gateway public key, which
//     is loaded from disk at boot. Threading that through every call site
//     would be invasive; instead we resolve once on first use and cache.
//
//   - Self short-circuit only when nova.did is did:web. If Nova is still
//     using did:key (the pre-Phase-1 default), the default plugin set
//     handles its own UCANs natively and the did:web plugin only matters
//     for peer Novas. Setting selfDid only when relevant keeps the test
//     surface small.
//
//   - One Plugins instance per process. Re-creating it on every call would
//     leak the in-process resolution cache. The closure captures the cache
//     for the lifetime of the process.

import { Plugins, getPluginInjectedApi } from '@ucans/core';
import { defaults as defaultPlugins } from '@ucans/default-plugins';
import { createDidWebPlugin } from './did-web-plugin';
import { loadNovaDid, loadNovaPrivateKey } from './invites';
import { createPublicKey } from 'crypto';

type InjectedApi = ReturnType<typeof getPluginInjectedApi>;

let pendingInit: Promise<InjectedApi> | null = null;
let cachedApi: InjectedApi | null = null;

async function init(): Promise<InjectedApi> {
  const novaDid = await loadNovaDid();
  let selfDid: string | undefined;
  let selfPublicKey: ReturnType<typeof createPublicKey> | undefined;
  if (novaDid?.startsWith('did:web:')) {
    selfDid = novaDid;
    selfPublicKey = createPublicKey(await loadNovaPrivateKey());
  }

  const webPlugin = createDidWebPlugin({ selfDid, selfPublicKey });
  const merged = new Plugins(
    defaultPlugins.keys,
    { ...defaultPlugins.methods, web: webPlugin },
  );
  cachedApi = getPluginInjectedApi(merged);
  return cachedApi;
}

async function getApi(): Promise<InjectedApi> {
  if (cachedApi) return cachedApi;
  if (!pendingInit) pendingInit = init();
  return pendingInit;
}

/** Drop in for `@ucans/ucans`'s `validate`. Resolves did:web issuers via the plugin. */
export async function novaUcansValidate(jwt: string, opts?: Parameters<InjectedApi['validate']>[1]): Promise<ReturnType<InjectedApi['validate']>> {
  const api = await getApi();
  return api.validate(jwt, opts);
}

/** Reset the cached api — only used by tests. */
export function _resetUcanPluginsForTests(): void {
  cachedApi = null;
  pendingInit = null;
}
