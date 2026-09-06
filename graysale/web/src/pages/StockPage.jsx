import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../api/AuthContext';
import { useToast } from '../components/Toast';
import { api } from '../api/client';
import Modal from '../components/Modal';
import DataTable from '../components/DataTable';
import { fmtMoney } from '../lib/format';

const TIER_NAMES = ['Wholesale', 'Member', 'Reseller'];
const UOM_NAMES = ['each', 'box', 'case', 'kg', 'g', 'L', 'ml'];
const BATCH_TYPES = ['RECEIPT', 'MANUAL_IN'];
const BC_FORMATS = ['CODE128', 'EAN13', 'UPC-A', 'CODE39', 'ITF'];

const emptyForm = () => ({
  name: '', sku: '', barcode: '', description: '', brand: '', manufacturerPartNo: '',
  hsCode: '', categoryId: '', unit: 'each', binLocation: '',
  costCents: '', priceCents: '', taxClassId: 2, reorderLevel: 0,
  minStock: 0, maxStock: 0, leadTimeDays: 0, warrantyDays: 0,
  weightGrams: '', lengthMm: '', widthMm: '', heightMm: '',
  serialTracked: false, active: true,
  tiers: [], barcodes: [], uom: [], bundleComponents: [],
});

export default function StockPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState('');
  const [catId, setCatId] = useState('');
  const [cats, setCats] = useState([]);
  const [taxClasses, setTaxClasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);   // null | {} (new) | product
  const [tab, setTab] = useState('general');
  const [form, setForm] = useState(emptyForm());
  const [adjusting, setAdjusting] = useState(null);
  const [adjustForm, setAdjustForm] = useState({ qty: 0, type: 'ADJUST', note: '' });
  const [newBarcode, setNewBarcode] = useState({ barcode: '', format: 'CODE128' });
  const [saving, setSaving] = useState(false);
  const [batchForm, setBatchForm] = useState(null); // batch add modal
  const [newBatch, setNewBatch] = useState({ batchNo: '', manufactureDate: '', expiryDate: '', qtyOnHand: 0, location: '' });
  const [isAddingCategory, setIsAddingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');

  const load = useCallback(async (q, cid) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set('search', q);
      if (cid) params.set('categoryId', cid);
      const list = await api.get(`/products${params.toString() ? '?' + params.toString() : ''}`);
      setRows(Array.isArray(list) ? list : list.products || []);
    } catch (e) { if (e?.silent) return; toast.err(e.message); }
    finally { setLoading(false); }
  }, [toast]);

  const loadMeta = useCallback(async () => {
    try {
      const [c, t] = await Promise.all([api.get('/categories'), api.get('/tax-classes')]);
      setCats(Array.isArray(c) ? c : c.categories || []);
      setTaxClasses(Array.isArray(t) ? t : t.tax_classes || []);
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { loadMeta(); load('', ''); }, [loadMeta, load]);
  useEffect(() => { const t = setTimeout(() => load(search, catId), 200); return () => clearTimeout(t); }, [search, catId, load]);

  // Create a new category and refresh the category list. Returns created category or null.
  const createCategory = async (name) => {
    const n = (name || '').trim();
    if (!n) return null;
    try {
      await api.post('/categories', { name: n });
      // ensure latest categories are loaded
      const res = await api.get('/categories');
      const created = Array.isArray(res) ? res.find(c => c.name === n) : (res.categories || []).find(c => c.name === n);
      // refresh local meta
      await loadMeta();
      return created || null;
    } catch (e) { toast.err(e.message); return null; }
  };

  // Inline category selector with an "Add New Category" option.
  function CategorySelector({ value, onChange, placeholder = 'All categories' }) {
    if (isAddingCategory) {
      return (
        <div className="category-add inline" style={{ display: 'flex', gap: 8 }}>
          <input placeholder="New category name" value={newCategoryName} onChange={(e) => setNewCategoryName(e.target.value)} />
          <button className="btn btn-primary btn-sm" onClick={async () => {
            const created = await createCategory(newCategoryName);
            if (created) {
              setNewCategoryName(''); setIsAddingCategory(false);
              onChange && onChange(created.id);
              setCatId(created.id);
            }
          }}>Save</button>
          <button className="btn btn-ghost btn-sm" onClick={() => { setIsAddingCategory(false); setNewCategoryName(''); }}>Cancel</button>
        </div>
      );
    }

    return (
      <select value={value} onChange={(e) => {
        const v = e.target.value;
        if (v === '__add_new__') { setIsAddingCategory(true); setTimeout(() => { const el = document.querySelector('.category-add input'); if (el) el.focus(); }, 10); }
        else { onChange && onChange(v); }
      }}>
        <option value="">{placeholder}</option>
        {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        <option value="__add_new__">+ Add New Category...</option>
      </select>
    );
  }

  const openNew = () => {
    if (!catId && cats.length) setForm({ ...emptyForm(), categoryId: cats[0].id });
    setEditing({});
    setTab('general');
  };
  const openEdit = (r) => {
    const f = emptyForm();
    for (const [key, col] of Object.entries({
      sku: 'sku', barcode: 'barcode', name: 'name', description: 'description', brand: 'brand',
      manufacturerPartNo: 'manufacturer_part_no', hsCode: 'hs_code', categoryId: 'category_id',
      unit: 'unit', binLocation: 'bin_location', costCents: 'cost_cents', priceCents: 'price_cents',
      taxClassId: 'tax_class_id', reorderLevel: 'reorder_level', minStock: 'min_stock',
      maxStock: 'max_stock', leadTimeDays: 'lead_time_days', warrantyDays: 'warranty_days',
      weightGrams: 'weight_grams', lengthMm: 'length_mm', widthMm: 'width_mm', heightMm: 'height_mm',
    })) {
      f[key] = r[col] ?? '';
    }
    f.serialTracked = !!r.serial_tracked;
    f.active = !!r.active;
    f.tiers = (r.tiers || []).map((t) => ({ tierName: t.tier_name, priceCents: t.price_cents, minQty: t.min_qty }));
    f.barcodes = (r.barcodes || []).filter((b) => b.active).map((b) => ({ barcode: b.barcode, format: b.format, isPrimary: !!b.is_primary }));
    f.uom = (r.uom || []).map((u) => ({ uomName: u.uom_name, conversionFactor: u.conversion_factor, isBase: !!u.is_base, priceOverrideCents: u.price_override_cents }));
    f.bundleComponents = (r.bundle_components || []).map((c) => ({ componentProductId: c.component_product_id, qtyRequired: c.qty_required, name: c.name, sku: c.sku }));
    setForm(f);
    setEditing(r);
    setTab('general');
  };

  const addTier = () => setForm({ ...form, tiers: [...form.tiers, { tierName: '', priceCents: '', minQty: 1 }] });
  const addUom = () => setForm({ ...form, uom: [...form.uom, { uomName: '', conversionFactor: 1, isBase: false, priceOverrideCents: '' }] });
  const addBundleComp = () => setForm({ ...form, bundleComponents: [...form.bundleComponents, { componentProductId: '', qtyRequired: 1 }] });

  const setTier = (i, k, v) => setForm({ ...form, tiers: form.tiers.map((t, x) => x === i ? { ...t, [k]: v } : t) });
  const setUomF = (i, k, v) => setForm({ ...form, uom: form.uom.map((u, x) => x === i ? { ...u, [k]: v } : u) });
  const setBc = (i, k, v) => setForm({ ...form, barcodes: form.barcodes.map((b, x) => x === i ? { ...b, [k]: v } : b) });
  const setComp = (i, k, v) => setForm({ ...form, bundleComponents: form.bundleComponents.map((c, x) => x === i ? { ...c, [k]: v } : c) });

  const save = async () => {
    if (!form.name) { toast.warn('Name required'); return; }
    if (!form.sku) { toast.warn('SKU required'); return; }
    setSaving(true);
    const payload = {
      ...form,
      costCents: Math.round(Number(form.costCents) * 100),
      priceCents: Math.round(Number(form.priceCents) * 100),
      weightGrams: Math.round(Number(form.weightGrams) || 0),
      tiers: form.tiers.filter((t) => t.tierName && t.priceCents !== '').map((t) => ({ ...t, priceCents: Math.round(Number(t.priceCents) * 100), minQty: Math.round(Number(t.minQty) || 1) })),
      barcodes: form.barcodes.filter((b) => b.barcode),
      uom: form.uom.filter((u) => u.uomName).map((u) => ({ ...u, priceOverrideCents: u.priceOverrideCents === '' ? null : Math.round(Number(u.priceOverrideCents) * 100) })),
      bundleComponents: form.bundleComponents.filter((c) => c.componentProductId).map((c) => ({ componentProductId: c.componentProductId, qtyRequired: Math.round(Number(c.qtyRequired) || 1) })),
    };
    try {
      if (editing?.id) await api.put(`/products/${editing.id}`, payload);
      else await api.post('/products', payload);
      toast.ok(editing?.id ? 'Product updated' : 'Product created');
      setEditing(null);
      load(search, catId);
    } catch (e) { if (e?.silent) return; toast.err(e.message); }
    finally { setSaving(false); }
  };

  const doAdjust = async () => {
    try {
      await api.post('/inventory/adjust', { productId: adjustForm.productId, qty: Number(adjustForm.qty), type: adjustForm.type, note: adjustForm.note });
      toast.ok('Stock adjusted');
      setAdjusting(null); load(search, catId);
    } catch (e) { if (e?.silent) return; toast.err(e.message); }
  };

  const saveBatch = async () => {
    if (!newBatch.batchNo) { toast.warn('Batch no required'); return; }
    try {
      await api.post(`/products/${batchForm.id}/batches`, newBatch);
      toast.ok(`Batch ${newBatch.batchNo} added`);
      setBatchForm(null); setNewBatch({ batchNo: '', manufactureDate: '', expiryDate: '', qtyOnHand: 0, location: '' });
      load(search, catId);
    } catch (e) { if (e?.silent) return; toast.err(e.message); }
  };

  const addBarcodeRow = () => {
    if (!newBarcode.barcode) { toast.warn('Enter a barcode'); return; }
    setForm({ ...form, barcodes: [...form.barcodes, { ...newBarcode, isPrimary: form.barcodes.length === 0 }] });
    setNewBarcode({ barcode: '', format: 'CODE128' });
  };

  // margin convenience
  const marginPct = (f) => {
    const c = Number(f.costCents) || 0, p = Number(f.priceCents) || 0;
    if (p <= 0) return 0;
    return Math.round(((p - c) / p) * 100);
  };

  const columns = [
    { key: 'name', label: 'Product', render: (r) => (
      <div className="cd"><div className="cd-txt"><div className="cd-nm">{r.name}</div>
        <div className="cd-sub">{r.sku} · {r.barcode || '—'}{r.brand ? ' · ' + r.brand : ''}{r.is_bundle ? ' · KIT' : ''}</div></div></div> ) },
    { key: 'category', label: 'Category', render: (r) => <span className="muted">{r.category_name || '—'}</span> },
    { key: 'price', label: 'Price', num: true, render: (r) => fmtMoney(r.price_cents) },
    { key: 'tiers', label: 'Tiers', num: true, render: (r) => (r.tiers?.length ? `${r.tiers.length}` : '—') },
    { key: 'bin', label: 'Bin', render: (r) => <span className="mono muted">{r.bin_location || '—'}</span> },
    { key: 'stock', label: 'Stock', num: true, render: (r) => <span className={r.qty_on_hand <= (r.reorder_level || 0) ? 'danger' : ''}>{r.qty_on_hand}</span> },
    { key: 'reorder', label: 'Reorder', num: true, render: (r) => r.reorder_level ?? '—' },
    { key: 'actions', label: 'Actions', render: (r) => (
      <div className="row-actions">
        {can('catalog.manage') && <button className="btn-link" onClick={() => openEdit(r)}>Edit</button>}
        {can('inventory.adjust') && <button className="btn-link" onClick={() => { setAdjusting({ ...r, productId: r.id }); setAdjustForm({ qty: 0, type: 'ADJUST', note: '' }); }}>Adjust</button>}
        {can('inventory.adjust') && r.serial_tracked && <button className="btn-link" onClick={() => { setBatchForm(r); setNewBatch({ batchNo: '', manufactureDate: '', expiryDate: '', qtyOnHand: 0, location: r.bin_location || '' }); }}>Batch</button>}
        {can('catalog.manage') && <button className="btn-link danger" onClick={async () => { if (!window.confirm(`Deactivate ${r.name}?`)) return; try { await api.del(`/products/${r.id}`); toast.ok('Product deactivated'); load(search, catId); } catch (e) { if (e?.silent) return; toast.err(e.message); } }}>Remove</button>}
      </div>
    ) },
  ];

  return (
    <div className="page">
      <div className="page-hd">
        <div className="page-title"><h1>Stock &amp; Products</h1><p>Industry-grade catalog, pricing, batches and units.</p></div>
        <button className="btn btn-primary" onClick={openNew} disabled={!can('catalog.manage')}>+ New product</button>
      </div>
      <div className="toolbar">
        <input className="search-input" placeholder="Search name / SKU / barcode / brand / part #…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <CategorySelector value={catId} onChange={(v) => setCatId(v)} placeholder="All categories" />
      </div>
      {loading ? <div className="loader"><span className="spinner" />Loading catalog…</div> : (
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} empty="No products match."
          caption={<div className="table-capt"><span className="tc-count">{rows.length} items</span><span className="tc-note">Kit = bundle</span></div>} />
      )}

      {/* ============ create / edit modal ============ */}
      {editing && (
        <Modal title={editing?.id ? `Edit — ${form.name || editing.name}` : 'New product'} onClose={() => setEditing(null)} wide
          footer={
            <div className="modal-actions">
              <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : editing?.id ? 'Save changes' : 'Create product'}</button>
            </div>
          }>
          <div className="tabs-strip">
            {[['general', 'General'], ['pricing', 'Pricing'], ['identifiers', 'Identifiers'], ['inventory', 'Inventory'], ['physical', 'Physical'], ['media', 'Media'], ['bundle', 'Bundle']].map(([k, label]) => (
              <button key={k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>{label}</button>
            ))}
          </div>
          <div className="stock-tab">
            {tab === 'general' && (
              <>
                <div className="field"><label>Name *</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
                <div className="field"><label>SKU *</label><input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} disabled={!!editing?.id} /></div>
                <div className="field"><label>Category</label><CategorySelector value={form.categoryId} onChange={(v) => setForm({ ...form, categoryId: v })} placeholder="None" /></div>
                <div className="field"><label>Brand / Manufacturer</label><input value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} /></div>
                <div className="field"><label>Description</label><textarea rows="3" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
                <div className="field"><label>Base unit</label>
                  <select value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })}>
                    {['each', 'box', 'case', 'kg', 'g', 'L', 'ml'].map((u) => <option key={u} value={u}>{u}</option>)}
                  </select></div>
                <label className="check"><input type="checkbox" checked={form.serialTracked} onChange={(e) => setForm({ ...form, serialTracked: e.target.checked })} /> Batch / serial-tracked</label>
                <div className="field"><label>Active</label><select value={form.active ? 1 : 0} onChange={(e) => setForm({ ...form, active: e.target.value === '1' })}>
                  <option value={1}>Active</option><option value={0}>Inactive</option></select></div>
              </>
            )}

            {tab === 'pricing' && (
              <>
                <div className="fields-3">
                  <div className="field"><label>Cost</label><input className="mono" value={form.costCents} onChange={(e) => setForm({ ...form, costCents: e.target.value })} /></div>
                  <div className="field"><label>Selling price</label><input className="mono" value={form.priceCents} onChange={(e) => setForm({ ...form, priceCents: e.target.value })} /></div>
                  <div className="field"><label>Margin</label><div className="mono margin">{marginPct(form)}%</div></div>
                </div>
                <div className="field"><label>Tax class</label><select value={form.taxClassId} onChange={(e) => setForm({ ...form, taxClassId: e.target.value })}>
                  {taxClasses.map((t) => <option key={t.id} value={t.id}>{t.name} ({(t.rate_bps / 100).toFixed(1)}%)</option>)}</select></div>
                <div className="sub-hd">Tiered pricing</div>
                {form.tiers.map((t, i) => (
                  <div className="fields-3" key={i}>
                    <div className="field"><input placeholder="Tier name" value={t.tierName} onChange={(e) => setTier(i, 'tierName', e.target.value)} list="tier-names" /></div>
                    <div className="field"><input className="mono" placeholder="Price" value={t.priceCents} onChange={(e) => setTier(i, 'priceCents', e.target.value)} /></div>
                    <div className="field"><input type="number" placeholder="Min qty" value={t.minQty} onChange={(e) => setTier(i, 'minQty', e.target.value)} /></div>
                  </div>
                ))}
                <datalist id="tier-names">{TIER_NAMES.map((n) => <option key={n} value={n} />)}</datalist>
                <button className="btn btn-ghost btn-sm" onClick={addTier}>+ Add tier</button>
              </>
            )}

            {tab === 'identifiers' && (
              <>
                <div className="field"><label>Primary barcode</label><input value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} /></div>
                <div className="sub-hd">Additional barcodes</div>
                {form.barcodes.map((b, i) => (
                  <div className="fields-3" key={i}>
                    <input className="mono" value={b.barcode} onChange={(e) => setBc(i, 'barcode', e.target.value)} placeholder="barcode" />
                    <select value={b.format} onChange={(e) => setBc(i, 'format', e.target.value)}>{BC_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}</select>
                    <button className="btn btn-ghost btn-sm" onClick={() => setForm({ ...form, barcodes: form.barcodes.filter((_, x) => x !== i) })}>Remove</button>
                  </div>
                ))}
                <div className="fields-3">
                  <input className="mono" value={newBarcode.barcode} onChange={(e) => setNewBarcode({ ...newBarcode, barcode: e.target.value })} placeholder="scan or type" />
                  <select value={newBarcode.format} onChange={(e) => setNewBarcode({ ...newBarcode, format: e.target.value })}>{BC_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}</select>
                  <button className="btn btn-ghost btn-sm" onClick={addBarcodeRow}>+ Add</button>
                </div>
                <div className="fields-2">
                  <div className="field"><label>Manufacturer part #</label><input value={form.manufacturerPartNo} onChange={(e) => setForm({ ...form, manufacturerPartNo: e.target.value })} /></div>
                  <div className="field"><label>HS Code</label><input value={form.hsCode} onChange={(e) => setForm({ ...form, hsCode: e.target.value })} /></div>
                </div>
              </>
            )}

            {tab === 'inventory' && (
              <>
                <div className="field"><label>Bin / shelf location</label><input value={form.binLocation} onChange={(e) => setForm({ ...form, binLocation: e.target.value })} placeholder="e.g. A-01-03" /></div>
                <label className="check"><input type="checkbox" checked={form.serialTracked} onChange={(e) => setForm({ ...form, serialTracked: e.target.checked })} /> Batch / serial / lot tracked</label>
                <div className="fields-4">
                  <div className="field"><label>Reorder level</label><input type="number" value={form.reorderLevel} onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })} /></div>
                  <div className="field"><label>Min stock</label><input type="number" value={form.minStock} onChange={(e) => setForm({ ...form, minStock: e.target.value })} /></div>
                  <div className="field"><label>Max stock</label><input type="number" value={form.maxStock} onChange={(e) => setForm({ ...form, maxStock: e.target.value })} /></div>
                  <div className="field"><label>Lead time (days)</label><input type="number" value={form.leadTimeDays} onChange={(e) => setForm({ ...form, leadTimeDays: e.target.value })} /></div>
                </div>
              </>
            )}

            {tab === 'physical' && (
              <>
                <div className="field"><label>Weight (g)</label><input type="number" value={form.weightGrams} onChange={(e) => setForm({ ...form, weightGrams: e.target.value })} /></div>
                <div className="fields-3">
                  <div className="field"><label>Length (mm)</label><input type="number" value={form.lengthMm} onChange={(e) => setForm({ ...form, lengthMm: e.target.value })} /></div>
                  <div className="field"><label>Width (mm)</label><input type="number" value={form.widthMm} onChange={(e) => setForm({ ...form, widthMm: e.target.value })} /></div>
                  <div className="field"><label>Height (mm)</label><input type="number" value={form.heightMm} onChange={(e) => setForm({ ...form, heightMm: e.target.value })} /></div>
                </div>
                <div className="field"><label>Warranty (days)</label><input type="number" value={form.warrantyDays} onChange={(e) => setForm({ ...form, warrantyDays: e.target.value })} /></div>
              </>
            )}

            {tab === 'media' && (
              <div className="field"><label>UOM conversions</label>
                {form.uom.map((u, i) => (
                  <div className="fields-4" key={i}>
                    <input placeholder="UOM" value={u.uomName} onChange={(e) => setUomF(i, 'uomName', e.target.value)} list="uom-names" />
                    <input type="number" placeholder="× base" value={u.conversionFactor} onChange={(e) => setUomF(i, 'conversionFactor', e.target.value)} />
                    <input className="mono" placeholder="Override price" value={u.priceOverrideCents ?? ''} onChange={(e) => setUomF(i, 'priceOverrideCents', e.target.value)} />
                    <button className="btn btn-ghost btn-sm" onClick={() => setForm({ ...form, uom: form.uom.filter((_, x) => x !== i) })}>Remove</button>
                  </div>
                ))}
                <datalist id="uom-names">{UOM_NAMES.map((n) => <option key={n} value={n} />)}</datalist>
                <button className="btn btn-ghost btn-sm" onClick={addUom}>+ Add UOM</button>
              </div>
            )}

            {tab === 'bundle' && (
              <>
                <p className="hint">A bundle (kit) sells as one line but pulls stock from its component products.</p>
                {form.bundleComponents.map((c, i) => (
                  <div className="fields-4" key={i}>
                    <input placeholder="Component product ID or SKU" value={c.componentProductId} onChange={(e) => setComp(i, 'componentProductId', e.target.value)} />
                    <input type="number" placeholder="Qty" value={c.qtyRequired} onChange={(e) => setComp(i, 'qtyRequired', e.target.value)} />
                    <span className="muted mono">{c.name || ''} {c.sku ? `(${c.sku})` : ''}</span>
                    <button className="btn btn-ghost btn-sm" onClick={() => setForm({ ...form, bundleComponents: form.bundleComponents.filter((_, x) => x !== i) })}>Remove</button>
                  </div>
                ))}
                <button className="btn btn-ghost btn-sm" onClick={addBundleComp}>+ Add component</button>
              </>
            )}
          </div>
        </Modal>
      )}

      {/* adjust stock modal */}
      {adjusting && (
        <Modal title={`Adjust stock — ${adjusting.name}`} onClose={() => setAdjusting(null)}
          footer={<button className="btn btn-primary" onClick={doAdjust}>Apply adjustment</button>}>
          <div className="field"><label>Qty change (+/-)</label><input type="number" value={adjustForm.qty} onChange={(e) => setAdjustForm({ ...adjustForm, qty: e.target.value })} /></div>
          <div className="field"><label>Type</label><select value={adjustForm.type} onChange={(e) => setAdjustForm({ ...adjustForm, type: e.target.value })}>
            <option value="ADJUST">Adjust</option><option value="COUNT">Stock count</option><option value="DAMAGED">Damaged</option><option value="WRITE_OFF">Write-off</option></select></div>
          {adjusting.serial_tracked && (
            <div className="field"><label>Batch (optional, decrement specific batch)</label>
              <select value={adjustForm.batchNo || ''} onChange={(e) => setAdjustForm({ ...adjustForm, batchNo: e.target.value })}>
                <option value="">—</option>{(adjusting.batches || []).filter((b) => b.qty_on_hand > 0).map((b) => <option key={b.id} value={b.batch_no}>{b.batch_no} ({b.qty_on_hand})</option>)}</select></div>
          )}
          <div className="field"><label>Note</label><input value={adjustForm.note} onChange={(e) => setAdjustForm({ ...adjustForm, note: e.target.value })} /></div>
        </Modal>
      )}

      {/* add batch modal */}
      {batchForm && (
        <Modal title={`Add batch — ${batchForm.name}`} onClose={() => setBatchForm(null)}
          footer={<button className="btn btn-primary" onClick={saveBatch}>Add batch</button>}>
          <div className="field"><label>Batch / Lot no *</label><input className="mono" value={newBatch.batchNo} onChange={(e) => setNewBatch({ ...newBatch, batchNo: e.target.value })} /></div>
          <div className="fields-2">
            <div className="field"><label>Manufacture date</label><input type="date" value={newBatch.manufactureDate} onChange={(e) => setNewBatch({ ...newBatch, manufactureDate: e.target.value })} /></div>
            <div className="field"><label>Expiry date</label><input type="date" value={newBatch.expiryDate} onChange={(e) => setNewBatch({ ...newBatch, expiryDate: e.target.value })} /></div>
          </div>
          <div className="field"><label>Qty on hand (adds to stock)</label><input type="number" value={newBatch.qtyOnHand} onChange={(e) => setNewBatch({ ...newBatch, qtyOnHand: e.target.value })} /></div>
          <div className="field"><label>Location</label><input value={newBatch.location} onChange={(e) => setNewBatch({ ...newBatch, location: e.target.value })} /></div>
        </Modal>
      )}
    </div>
  );
}
