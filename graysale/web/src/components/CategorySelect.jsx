import { useState } from 'react';

// Category dropdown with inline creation. Used both as a filter ("All
// categories") and inside the product form ("None"). Adding a new category
// reveals an inline input; on success the created category is auto-selected.
export default function CategorySelector({
  value,
  onChange,
  categories = [],
  onAddCategory,
  placeholder = 'None',
  canAdd = true,
}) {
  const [isAdding, setIsAdding] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    if (!newCategoryName.trim()) return;
    if (typeof onAddCategory === 'function') {
      setSaving(true);
      try {
        const created = await onAddCategory(newCategoryName.trim());
        if (created && created.id) {
          onChange && onChange(created.id);
        } else {
          return;
        }
      } finally {
        setSaving(false);
      }
    }
    setNewCategoryName('');
    setIsAdding(false);
  };

  return (
    <div className="cat-select">
      {!isAdding ? (
        <>
          <select
            value={value || ''}
            onChange={(e) => {
              if (e.target.value === '__add_new__') setIsAdding(true);
              else onChange && onChange(e.target.value);
            }}
            className="cat-select-input"
            aria-label="Category"
          >
            <option value="">{placeholder}</option>
            {categories.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.name}
              </option>
            ))}
            {canAdd && (
              <option value="__add_new__" className="cat-add-opt">
                + Add New Category...
              </option>
            )}
          </select>
          {canAdd && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setIsAdding(true)}
              title="Add new category"
            >
              + Add
            </button>
          )}
        </>
      ) : (
        <>
          <input
            type="text"
            placeholder="Enter new category name"
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            className="cat-select-input"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate();
              if (e.key === 'Escape') {
                setIsAdding(false);
                setNewCategoryName('');
              }
            }}
          />
          <button
            type="button"
            onClick={handleCreate}
            className="btn btn-primary btn-sm"
            disabled={saving || !newCategoryName.trim()}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => {
              setIsAdding(false);
              setNewCategoryName('');
            }}
            className="btn btn-ghost btn-sm"
          >
            Cancel
          </button>
        </>
      )}
    </div>
  );
}
