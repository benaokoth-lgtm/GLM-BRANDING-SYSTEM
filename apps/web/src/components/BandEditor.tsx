// The table of bands (from this much, pays this %) an Admin edits under Commission → Rates and Commission → Freelancers → Rates.

export default function BandEditor({ title, hint, unit, bands, onChange }: { title: string; hint: string; unit: string; bands: { from: string; rate: string }[]; onChange: (b: { from: string; rate: string }[]) => void }) {
  return (
    <div>
      <div className="card-kicker">{title}</div>
      <p className="note" style={{ marginTop: 0 }}>{hint}</p>
      <div style={{ overflowX: 'auto' }}>
<table className="table" style={{ maxWidth: 480 }}>
        <thead>
          <tr>
            <th>From ({unit})</th>
            <th>Pays (%)</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {bands.map((b, i) => (
            <tr key={i}>
              <td>
                <input className="input" inputMode="decimal" value={b.from} disabled={i === 0} onChange={(e) => onChange(bands.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
              </td>
              <td>
                <input className="input" inputMode="decimal" value={b.rate} onChange={(e) => onChange(bands.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))} />
              </td>
              <td>{i > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(bands.filter((_, j) => j !== i))}>✕</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
</div>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => onChange([...bands, { from: '', rate: '' }])}>
        + Add band
      </button>
    </div>
  );
}
