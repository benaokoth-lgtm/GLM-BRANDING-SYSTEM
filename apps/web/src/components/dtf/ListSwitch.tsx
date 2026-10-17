import { PRICE_LIST_LABEL } from '@glm/shared';
import type { PriceList } from '@glm/shared';

/** GLM | Freelancer: which price list a DTF screen is showing and changing. */
export default function ListSwitch({ value, onChange }: { value: PriceList; onChange: (v: PriceList) => void }) {
  return (
    <div className="seg no-print" role="radiogroup" aria-label="Price list" style={{ marginBottom: 'var(--space-3)' }}>
      {(['glm', 'freelancer'] as PriceList[]).map((k) => (
        <label key={k} className={'seg-opt' + (value === k ? ' checked' : '')}>
          <input type="radio" name="dtflist" checked={value === k} onChange={() => onChange(k)} />
          {PRICE_LIST_LABEL[k]}
        </label>
      ))}
    </div>
  );
}
