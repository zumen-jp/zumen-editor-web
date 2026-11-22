import type { CheckProfileMeta } from "./types";

export type LoadedProfileAsset = {
  meta: CheckProfileMeta;
  inputName: string;
  bytes: Uint8Array;
  extendsRef?: { id: string; edition: string };
};

export interface ZumenAssetLoader {
  loadCatalogBytes(): Promise<Uint8Array | null>;
  listProfiles(): Promise<LoadedProfileAsset[]>;
}

const PUBLIC_PROFILE_PATHS = [
  "mlit-cad/2025-12",
  "mlit-cad-building-drawing/2025-12",
  "zumen-building-drawing/2026-11",
] as const;

export function parseProfileAsset(slug: string, bytes: Uint8Array): LoadedProfileAsset | null {
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8").decode(bytes)) as Record<string, unknown>;
    const [fallbackId, fallbackEdition] = slug.split("/");
    const id = typeof parsed.id === "string" ? parsed.id : (fallbackId ?? slug);
    const edition = typeof parsed.edition === "string" ? parsed.edition : (fallbackEdition ?? "");
    const title = typeof parsed.title === "string" ? parsed.title : id;
    const revision = typeof parsed.revision === "number" ? parsed.revision : 1;
    const ext = parsed.extends as Record<string, unknown> | undefined;
    const extendsRef =
      ext && typeof ext.id === "string" && typeof ext.edition === "string"
        ? { id: ext.id, edition: ext.edition }
        : undefined;
    return {
      meta: { id, edition, title, revision },
      inputName: `zumen-editor-web/profiles/${id}/${edition}.json`,
      bytes,
      ...(extendsRef ? { extendsRef } : {}),
    };
  } catch {
    return null;
  }
}

export function resolveProfileChain(
  all: readonly LoadedProfileAsset[],
  targetId: string,
  targetEdition?: string,
): LoadedProfileAsset[] {
  const target = all.find(
    (p) => p.meta.id === targetId && (!targetEdition || p.meta.edition === targetEdition),
  );
  if (!target) return [];
  const reversed: LoadedProfileAsset[] = [target];
  const seen = new Set([`${target.meta.id}/${target.meta.edition}`]);
  let cursor: LoadedProfileAsset | undefined = target;
  while (cursor?.extendsRef) {
    const key = `${cursor.extendsRef.id}/${cursor.extendsRef.edition}`;
    if (seen.has(key)) break;
    const parent = all.find(
      (p) => p.meta.id === cursor!.extendsRef!.id && p.meta.edition === cursor!.extendsRef!.edition,
    );
    if (!parent) break;
    seen.add(key);
    reversed.push(parent);
    cursor = parent;
  }
  return reversed.reverse();
}

export class BrowserZumenAssetLoader implements ZumenAssetLoader {
  private catalogPromise: Promise<Uint8Array | null> | null = null;
  private profilesPromise: Promise<LoadedProfileAsset[]> | null = null;

  loadCatalogBytes(): Promise<Uint8Array | null> {
    if (!this.catalogPromise) {
      this.catalogPromise = fetch("/assets/zumen/catalog/ja.json")
        .then(async (res) => (res.ok ? new Uint8Array(await res.arrayBuffer()) : null))
        .catch(() => null);
    }
    return this.catalogPromise;
  }

  listProfiles(): Promise<LoadedProfileAsset[]> {
    if (!this.profilesPromise) {
      this.profilesPromise = Promise.all(
        PUBLIC_PROFILE_PATHS.map(async (slug) => {
          try {
            const res = await fetch(`/assets/zumen/profiles/${slug}/profile.json`);
            if (!res.ok) return null;
            return parseProfileAsset(slug, new Uint8Array(await res.arrayBuffer()));
          } catch {
            return null;
          }
        }),
      ).then((items) => items.filter((item): item is LoadedProfileAsset => item !== null));
    }
    return this.profilesPromise;
  }
}
