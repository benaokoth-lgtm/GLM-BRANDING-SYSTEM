import { useState } from 'react';
import { fmtKsh } from '@glm/shared';
import type { ArtworkSizeBand } from '../api/models';

interface Props {
  artworkSizeBands: ArtworkSizeBand[];
  onApply: (result: { areaSqm: number; band: ArtworkSizeBand | null }) => void;
  onClose: () => void;
}

// Does a captured artwork (length x width, either orientation) fit within a
// band's own length x width? A strict bounding-box check, not just an area
// comparison — two shapes can share an area while one is too long/narrow to
// actually sit in a given slot.
function bandFits(band: ArtworkSizeBand, lengthCm: number, widthCm: number): boolean {
  return (band.lengthCm >= lengthCm && band.widthCm >= widthCm) || (band.lengthCm >= widthCm && band.widthCm >= lengthCm);
}

// The smallest (tightest-fitting) band the artwork fits within, or null if
// it's bigger than every defined band in both orientations — that's the
// signal to fall back to the continuous area x Ksh/sqm formula instead.
export function findMatchingBand(bands: ArtworkSizeBand[], lengthCm: number, widthCm: number): ArtworkSizeBand | null {
  const fits = bands.filter((b) => bandFits(b, lengthCm, widthCm));
  if (fits.length === 0) return null;
  return fits.reduce((best, b) => (b.areaSqm < best.areaSqm ? b : best), fits[0]);
}

// Length x width (cm) -> area (sqm), for the DTF Printing "Artwork size"
// field — staff usually know a print's dimensions off the design, not its
// area, so doing the /10,000 conversion by hand is an easy place to slip.
// If the dimensions strictly fit a predefined size band, that band's flat
// price applies instead of the area-based formula (small prints are
// dominated by fixed setup/press time, not material) — film usage still
// deducts off the matched band's own area either way.
export default function ArtworkSizeDialog({ artworkSizeBands, onApply, onClose }: Props) {
  const [lengthCm, setLengthCm] = useState('');
  const [widthCm, setWidthCm] = useState('');

  const length = Number(lengthCm) || 0;
  const width = Number(widthCm) || 0;
  const areaSqm = length > 0 && width > 0 ? Math.round(((length * width) / 10000) * 10000) / 10000 : 0;
  const matchedBand = length > 0 && width > 0 ? findMatchingBand(artworkSizeBands, length, width) : null;

  function apply() {
    if (areaSqm > 0) onApply({ areaSqm, band: matchedBand });
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
            Enter the artwork's length and width. If it fits a predefined size, that size's flat price is used
            instead of the area-based formula.
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
          {areaSqm > 0 && (
            <p className="note" style={{ marginTop: 'var(--space-2)', textAlign: 'center' }}>
              {matchedBand ? (
                <>
                  Matches size band <strong>{matchedBand.label}</strong> — flat {fmtKsh(matchedBand.price)}/piece
                </>
              ) : (
                'No matching size band — priced by the area formula.'
              )}
            </p>
          )}
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
