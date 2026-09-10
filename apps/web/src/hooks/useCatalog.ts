import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { CatalogMaterial, CatalogService, CompanySettings, CorporateClient, StaffUser } from '../api/models';

const DEFAULT_SETTINGS: CompanySettings = {
  maxDiscountPct: 15,
  companyName: 'GLM Branding',
  companyAddress: '',
  companyPhone: '',
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
  reload: () => void;
}

export function useCatalog(): Catalog {
  const [services, setServices] = useState<CatalogService[]>([]);
  const [materials, setMaterials] = useState<CatalogMaterial[]>([]);
  const [corporateClients, setCorporateClients] = useState<CorporateClient[]>([]);
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [settings, setSettings] = useState<CompanySettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.get<CatalogService[]>('/master-data/services'),
      api.get<CatalogMaterial[]>('/master-data/materials'),
      api.get<CorporateClient[]>('/master-data/corporate-clients'),
      api.get<StaffUser[]>('/master-data/staff'),
      api.get<CompanySettings>('/master-data/settings'),
    ])
      .then(([sv, mt, cc, st, settingsRes]) => {
        setServices(sv);
        setMaterials(mt);
        setCorporateClients(cc);
        setStaff(st);
        setSettings(settingsRes);
      })
      .finally(() => setLoading(false));
  }, [tick]);

  return {
    services,
    materials,
    corporateClients,
    staff,
    settings,
    maxDiscountPct: settings.maxDiscountPct,
    loading,
    reload: () => setTick((t) => t + 1),
  };
}
