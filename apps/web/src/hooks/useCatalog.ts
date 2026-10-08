import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { CatalogMaterial, CatalogService, CompanySettings, CorporateClient, StaffUser } from '../api/models';

const DEFAULT_SETTINGS: CompanySettings = {
  maxDiscountPct: 15,
  // (empty until the company details load from Master Data — nothing is assumed)
  companyName: '',
  legalName: '',
  companyAddress: '',
  companyPhone: '',
  companyPhone2: '',
  website: '',
  facebook: '',
  tiktok: '',
  companyEmail: '',
  logoDataUrl: null,
};

export interface Catalog {
  services: CatalogService[];
  materials: CatalogMaterial[];
  corporateClients: CorporateClient[];
  staff: StaffUser[];
  settings: CompanySettings;
  maxDiscountPct: number;
  loading: boolean;
  /** Set when the last load failed (the lists shown are then the last good ones, or empty). */
  error: string | null;
  reload: () => void;
}

interface Snapshot {
  services: CatalogService[];
  materials: CatalogMaterial[];
  corporateClients: CorporateClient[];
  staff: StaffUser[];
  settings: CompanySettings;
}

// The catalogue (prices, materials, clients, staff, company settings) is read by most screens. It is kept here between screens, so moving from one screen to the
// next shows it at once while a fresh copy is fetched in the background, instead of every screen waiting for five requests. A person signing out clears it
// (a new session starts from scratch), and a failed load keeps the last good copy rather than blanking the screen.
let cache: Snapshot | null = null;
let cachedAt = 0;
const FRESH_MS = 60_000;

export function resetCatalogCache() {
  cache = null;
  cachedAt = 0;
}

export function useCatalog(): Catalog {
  const [snap, setSnap] = useState<Snapshot | null>(cache);
  const [loading, setLoading] = useState(!cache);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    // Fresh enough, and not asked to reload: nothing to fetch.
    if (cache && Date.now() - cachedAt < FRESH_MS && tick === 0) {
      setSnap(cache);
      setLoading(false);
      return;
    }
    let live = true;
    if (!cache) setLoading(true);
    Promise.all([
      api.get<CatalogService[]>('/master-data/services'),
      api.get<CatalogMaterial[]>('/master-data/materials'),
      api.get<CorporateClient[]>('/master-data/corporate-clients'),
      api.get<StaffUser[]>('/master-data/staff'),
      api.get<CompanySettings>('/master-data/settings'),
    ])
      .then(([services, materials, corporateClients, staff, settings]) => {
        cache = { services, materials, corporateClients, staff, settings };
        cachedAt = Date.now();
        if (live) {
          setSnap(cache);
          setError(null);
        }
      })
      .catch((err) => {
        if (live) setError(err instanceof Error ? err.message : 'Could not load the price lists');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [tick]);

  const s = snap ?? { services: [], materials: [], corporateClients: [], staff: [], settings: DEFAULT_SETTINGS };
  return {
    ...s,
    maxDiscountPct: s.settings.maxDiscountPct,
    loading,
    error,
    reload: () => setTick((t) => t + 1),
  };
}
