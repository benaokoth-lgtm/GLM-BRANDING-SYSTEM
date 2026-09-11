import { useState } from 'react';

interface Props {
  onApply: (areaSqm: number) => void;
  onClose: () => void;
}

// Length x width (cm) -> area (sqm), for the DTF Printing "Artwork size"
// field — staff usually know a print's dimensions off the design, not its
// area, so doing the /10,000 conversion by hand is an easy place to slip.
export default function ArtworkSizeDialog({ onApply, onClose }: Props) {
  const [lengthCm, setLengthCm] = useState('');
  const [widthCm, setWidthCm] = useState('');

  const length = Number(lengthCm) || 0;
  const width = Number(widthCm) || 0;
  const areaSqm = length > 0 && width > 0 ? Math.round(((length * width) / 10000) * 10000) / 10000 : 0;

  function apply() {
    if (areaSqm > 0) onApply(areaSqm);
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog blueprint" onClick={(e) => e.stopPropagation()}>
        <i className="corner tl"></i>
        <i className="corner tr"></i>
        <i className="corner bl"></i>
        <i className="corner br"></i>
        <div className="dialog-title">Artwork size</div>
        <div className="dialog-body">
          <p className="note" style={{ marginBottom: 'var(--space-3)' }}>
            Enter the artwork's length and width to compute its area in square metres.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
            <div className="field" style={{ margin: 0 }}>
              <label>Length (cm)</label>
              <input className="input" value={lengthCm} onChange={(e) => setLengthCm(e.target.value)} placeholder="e.g. 20" autoFocus />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Width (cm)</label>
              <input className="input" value={widthCm} onChange={(e) => setWidthCm(e.target.value)} placeholder="e.g. 30" />
            </div>
          </div>
          <div style={{ marginTop: 'var(--space-4)', fontFamily: 'var(--font-heading)', fontSize: 22, textAlign: 'center' }}>
            = {areaSqm > 0 ? `${areaSqm} sqm` : '—'}
          </div>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary blueprint" onClick={onClose}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            Cancel
          </button>
          <button type="button" className="btn btn-primary blueprint" onClick={apply} disabled={areaSqm <= 0}>
            <i className="corner tl"></i>
            <i className="corner tr"></i>
            <i className="corner bl"></i>
            <i className="corner br"></i>
            Use this size
          </button>
        </div>
      </div>
    </div>
  );
}
