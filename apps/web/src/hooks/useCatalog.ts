import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { CatalogMaterial, CatalogService, CorporateClient, StaffUser } from '../api/models';

export interface Catalog {
  services: CatalogService[];
  materials: CatalogMaterial[];
  corporateClients: CorporateClient[];
  staff: StaffUser[];
  maxDiscountPct: number;
  loading: boolean;
  reload: () => void;
}

export function useCatalog(): Catalog {
  const [services, setServices] = useState<CatalogService[]>([]);
  const [materials, setMaterials] = useState<CatalogMaterial[]>([]);
  const [corporateClients, setCorporateClients] = useState<CorporateClient[]>([]);
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [maxDiscountPct, setMaxDiscountPct] = useState(15);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.get<CatalogService[]>('/master-data/services'),
      api.get<CatalogMaterial[]>('/master-data/materials'),
      api.get<CorporateClient[]>('/master-data/corporate-clients'),
      api.get<StaffUser[]>('/master-data/staff'),
      api.get<{ maxDiscountPct: number }>('/master-data/settings'),
    ])
      .then(([sv, mt, cc, st, settings]) => {
        setServices(sv);
        setMaterials(mt);
        setCorporateClients(cc);
        setStaff(st);
        setMaxDiscountPct(settings.maxDiscountPct);
      })
      .finally(() => setLoading(false));
  }, [tick]);

  return { services, materials, corporateClients, staff, maxDiscountPct, loading, reload: () => setTick((t) => t + 1) };
}
