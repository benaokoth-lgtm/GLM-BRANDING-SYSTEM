import type { OrderStage, PaymentMethod, Role } from './types';

export const STAGES: OrderStage[] = [
  'Order Received',
  'In Production',
  'Quality Check',
  'Ready for Pickup/Delivery',
  'Completed',
];

export const PAYMENT_METHODS: PaymentMethod[] = ['Cash', 'M-Pesa', 'Bank Transfer', 'Card'];

export const ROLES: Role[] = ['Staff', 'Supervisor', 'Admin'];

export const ITEM_TYPE_LABELS: Record<string, string> = {
  'material-service': 'Material + Service',
  'service-only': "Service only (client's item)",
  'per-metre': 'Per-metre service',
};
