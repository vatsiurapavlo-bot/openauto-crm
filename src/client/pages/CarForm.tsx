import { useState, type FormEvent, type ReactNode } from 'react';
import type { Car } from '../../shared/types.ts';
import { api, ApiError } from '../api.ts';
import { useApp } from '../state.tsx';
import { Field, Icon, Modal, useToast } from '../ui.tsx';

type Values = Record<string, string>;

const INT_FIELDS = ['rokProdukcji', 'przebiegKm', 'pojemnoscCm3', 'mocKm'];
const CAR_FIELDS = [
  'marka', 'model', 'wersja', 'rokProdukcji', 'vin', 'numerRejestracyjny', 'przebiegKm', 'pojemnoscCm3', 'mocKm',
  'rodzajPaliwa', 'skrzyniaBiegow', 'kolor', 'dataZakupu', 'dataPrzyjazdu', 'dataSprzedazy', 'typZakupu',
  'krajZakupu', 'krajRejestracji', 'krajLokalizacji', 'krajSprzedawcy', 'krajFaktury', 'cenaA', 'cenaB', 'notatka',
];
const FIN_FIELDS = [
  'wartoscAuta', 'walutaZakupu', 'cenaZakupuWaluta', 'kursWaluty', 'uslugiAukcjiNetto', 'vatNaUslugi', 'akcyzaPcc',
  'trybZakupu', 'trybSprzedazy', 'kwotaNabyciaVatMarza', 'cenaSprzedazyFaktyczna',
];

const toForm = (v: unknown) => (v === null || v === undefined ? '' : String(v).replace(/\.00$/, ''));

function initialValues(car?: Car): Values {
  const v: Values = {};
  for (const k of CAR_FIELDS) v[k] = toForm(car?.[k as keyof Car]);
  for (const k of FIN_FIELDS) v['f.' + k] = toForm(car?.finance?.[k as keyof NonNullable<Car['finance']>]);
  if (!v['f.walutaZakupu']) v['f.walutaZakupu'] = 'PLN';
  return v;
}

function toPayload(k: string, s: string): unknown {
  const t = s.trim();
  if (t === '') return null;
  if (INT_FIELDS.includes(k)) return /^\d+$/.test(t.replace(/\s/g, '')) ? Number(t.replace(/\s/g, '')) : NaN;
  return t;
}

export function CarFormModal({ car, onClose, onSaved }: { car?: Car; onClose: () => void; onSaved: (c: Car) => void }) {
  const app = useApp();
  const toast = useToast();
  const initial = initialValues(car);
  const [v, setV] = useState<Values>(initial);
  const [logisticStatusId, setLogistic] = useState(app.statusByCode('logistic', 'w_drodze')?.id ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const finEdit = app.can('cars.finance.edit');
  const canEditCar = app.can(car ? 'cars.edit' : 'cars.create');

  const set = (k: string) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setFormError('');
    const body: Record<string, unknown> = {};
    const finance: Record<string, unknown> = {};
    for (const k of CAR_FIELDS) if (!car || v[k] !== initial[k]) body[k] = toPayload(k, v[k]);
    if (finEdit) for (const k of FIN_FIELDS) if (v['f.' + k] !== initial['f.' + k]) finance[k] = toPayload(k, v['f.' + k]) ?? (k === 'walutaZakupu' ? 'PLN' : null);
    if (Object.keys(finance).length) body.finance = finance;
    const intErr = INT_FIELDS.find((k) => Number.isNaN(body[k]));
    if (intErr) {
      setErrors({ [intErr]: 'Wpisz liczbę całkowitą' });
      setBusy(false);
      return;
    }
    try {
      let saved: Car;
      if (car) {
        if (!Object.keys(body).length) return onClose();
        saved = await api.patch<Car>(`/api/cars/${car.id}`, { ...body, version: car.version });
      } else {
        saved = await api.post<Car>('/api/cars', { ...body, logisticStatusId });
      }
      toast(car ? 'Zapisano zmiany' : `Dodano samochód ${saved.label}`);
      onSaved(saved);
    } catch (err) {
      const ae = err as ApiError;
      const fields: Record<string, string> = {};
      for (const [k, msg] of Object.entries(ae.fields ?? {})) fields[k.replace(/^finance\./, 'f.')] = msg;
      setErrors(fields);
      setFormError(ae.message);
    } finally {
      setBusy(false);
    }
  }

  const input = (k: string, label: string, opts: { type?: string; hint?: string; placeholder?: string; mode?: 'numeric' | 'decimal'; wide?: boolean; upper?: boolean } = {}) => (
    <Field label={label} error={errors[k]} hint={opts.hint} wide={opts.wide}>
      <input
        type={opts.type ?? 'text'}
        inputMode={opts.mode}
        value={v[k]}
        placeholder={opts.placeholder}
        onChange={(e) => set(k)({ target: { value: opts.upper ? e.target.value.toUpperCase() : e.target.value } })}
        disabled={k.startsWith('f.') ? !finEdit : !canEditCar}
        autoCapitalize={opts.upper ? 'characters' : undefined}
      />
    </Field>
  );

  const select = (k: string, label: string, options: Array<[string, string]>) => (
    <Field label={label} error={errors[k]}>
      <select value={v[k]} onChange={set(k)} disabled={k.startsWith('f.') ? !finEdit : !canEditCar}>
        <option value="">—</option>
        {options.map(([val, l]) => (
          <option key={val} value={val}>
            {l}
          </option>
        ))}
      </select>
    </Field>
  );

  const countries = app.meta.countries.filter((c) => c.active).map((c) => [c.code, `${c.name} (${c.code})`] as [string, string]);
  const opts = (list: string[]) => list.map((x) => [x, x] as [string, string]);

  return (
    <Modal title={car ? `Edycja: ${car.label}` : 'Nowy samochód'} onClose={onClose} wide>
      <form onSubmit={submit} className="form" noValidate>
        <Section title="Podstawowe">
          {input('marka', 'Marka *')}
          {input('model', 'Model *')}
          {input('wersja', 'Wersja', { placeholder: 'np. 2.0 TDI Highline' })}
          {input('rokProdukcji', 'Rok produkcji', { mode: 'numeric' })}
          {input('vin', 'VIN', { upper: true, hint: '17 znaków (bez I, O, Q)' })}
          {input('numerRejestracyjny', 'Numer rejestracyjny', { upper: true })}
          {!car && (
            <Field label="Status logistyczny">
              <select value={logisticStatusId} onChange={(e) => setLogistic(e.target.value)}>
                {app.meta.statuses
                  .filter((s) => s.kind === 'logistic' && s.active)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </Field>
          )}
        </Section>
        <Section title="Dane techniczne">
          {input('przebiegKm', 'Przebieg (km)', { mode: 'numeric' })}
          {input('pojemnoscCm3', 'Pojemność silnika (cm³)', { mode: 'numeric' })}
          {input('mocKm', 'Moc (KM)', { mode: 'numeric' })}
          {select('rodzajPaliwa', 'Rodzaj paliwa', opts(app.meta.fuelTypes))}
          {select('skrzyniaBiegow', 'Skrzynia biegów', opts(app.meta.gearboxTypes))}
          {input('kolor', 'Kolor')}
        </Section>
        <Section title="Zakup, daty i kraje" note="Kraje zapisujemy osobno — nie zakładamy, że są takie same.">
          {select('typZakupu', 'Typ zakupu', opts(app.meta.purchaseTypes))}
          {input('dataZakupu', 'Data zakupu', { type: 'date' })}
          {input('dataPrzyjazdu', 'Data przyjazdu', { type: 'date' })}
          {input('dataSprzedazy', 'Data sprzedaży', { type: 'date' })}
          {select('krajZakupu', 'Kraj zakupu', countries)}
          {select('krajRejestracji', 'Kraj rejestracji', countries)}
          {select('krajLokalizacji', 'Kraj lokalizacji', countries)}
          {select('krajSprzedawcy', 'Kraj sprzedawcy', countries)}
          {select('krajFaktury', 'Kraj wystawienia faktury', countries)}
        </Section>
        <Section title="Ceny ofertowe">
          {input('cenaA', 'Cena A (zł)', { mode: 'decimal', placeholder: '0,00' })}
          {input('cenaB', 'Cena B (zł)', { mode: 'decimal', placeholder: '0,00' })}
        </Section>
        {app.can('cars.finance.view') && (
          <Section
            title="Finanse zakupu"
            icon="lock"
            note={finEdit ? 'Widoczne tylko dla ról z dostępem do finansów.' : 'Tylko podgląd — brak uprawnień do edycji finansów.'}
          >
            {input('f.wartoscAuta', 'Wartość auta (zł)', { mode: 'decimal', hint: 'cena zakupu w PLN' })}
            {select('f.walutaZakupu', 'Waluta zakupu', opts(['PLN', 'EUR', 'CHF', 'SEK', 'DKK', 'CZK', 'GBP']))}
            {input('f.cenaZakupuWaluta', 'Cena w walucie', { mode: 'decimal' })}
            {input('f.kursWaluty', 'Kurs waluty', { mode: 'decimal', hint: 'np. kurs NBP z dnia zakupu' })}
            {input('f.uslugiAukcjiNetto', 'Usługi aukcji netto (zł)', { mode: 'decimal' })}
            {input('f.vatNaUslugi', 'VAT na usługi (zł)', { mode: 'decimal' })}
            {input('f.akcyzaPcc', 'PCC-3 / Akcyza (zł)', { mode: 'decimal' })}
            {select('f.trybZakupu', 'Tryb zakupu', [
              ['vat_marza', 'VAT-marża'],
              ['vat_23', 'Faktura VAT 23%'],
              ['vat_wdt', 'WNT / faktura 0% UE'],
              ['bez_vat', 'Bez VAT (osoba prywatna)'],
              ['inne', 'Inne'],
            ])}
            {select('f.trybSprzedazy', 'Tryb sprzedaży', [
              ['vat_marza', 'VAT-marża'],
              ['vat_23', 'Faktura VAT 23%'],
              ['inne', 'Inne'],
            ])}
            {input('f.kwotaNabyciaVatMarza', 'Kwota nabycia do VAT-marża (zł)', { mode: 'decimal', hint: 'wg dokumentów zakupu' })}
            {input('f.cenaSprzedazyFaktyczna', 'Cena sprzedaży faktyczna (zł)', { mode: 'decimal' })}
          </Section>
        )}
        <Section title="Notatka">
          <Field label="Notatka" error={errors.notatka} wide>
            <textarea rows={3} value={v.notatka} onChange={set('notatka')} disabled={!canEditCar} />
          </Field>
        </Section>

        {formError && (
          <div className="error-box" role="alert">
            <Icon name="alert" />
            <span>{formError}</span>
          </div>
        )}
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Anuluj
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Zapisywanie…' : car ? 'Zapisz zmiany' : 'Dodaj samochód'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Section({ title, note, icon, children }: { title: string; note?: string; icon?: string; children: ReactNode }) {
  return (
    <fieldset className="form-section">
      <legend>
        {icon && <Icon name={icon} size={14} />} {title}
      </legend>
      {note && <p className="muted small section-note">{note}</p>}
      <div className="form-grid">{children}</div>
    </fieldset>
  );
}
