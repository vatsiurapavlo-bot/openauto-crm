import { useMemo, useState, type FormEvent } from 'react';
import { PAYMENT_METHODS, type CarList, type Cost, type PaymentMethod } from '../../shared/types.ts';
import { toCents, toDecimalString } from '../../shared/money.ts';
import { fromGross, fromNet } from '../../shared/vat.ts';
import { api, ApiError } from '../api.ts';
import { useApp } from '../state.tsx';
import { Field, Icon, Modal, date, money, useLoad, useToast } from '../ui.tsx';

/** Wartości formularza — także do wstępnego wypełnienia (np. przez przyszłe wprowadzanie głosowe). */
export interface CostDraft {
  data: string;
  opis: string;
  categoryId: string;
  carId: string;
  vatRateId: string;
  kwota: string;
  kwotaTyp: 'netto' | 'brutto';
  sposobPlatnosci: PaymentMethod;
  czyFaktura: boolean;
  numerFaktury: string;
  vatDoOdliczenia: boolean | null;
  notatka: string;
}

export function today() {
  // data lokalna (Polska), nie UTC
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function newKey() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

const strip = (v: string) => v.replace(/\.00$/, '').replace('.', ',');

function fromCost(c: Cost): CostDraft {
  return {
    data: c.data,
    opis: c.opis,
    categoryId: c.categoryId,
    carId: c.carId ?? '',
    vatRateId: c.vatRateId ?? '',
    kwota: strip(c.kwotaBrutto),
    kwotaTyp: 'brutto',
    sposobPlatnosci: c.sposobPlatnosci,
    czyFaktura: c.czyFaktura,
    numerFaktury: c.numerFaktury ?? '',
    vatDoOdliczenia: c.vatDoOdliczenia,
    notatka: c.notatka ?? '',
  };
}

/** Podgląd kwot liczony tak samo jak na serwerze (te same funkcje). */
function preview(kwota: string, typ: 'netto' | 'brutto', rate: string) {
  try {
    const c = toCents(kwota);
    if (c <= 0n) return null;
    const r = typ === 'netto' ? fromNet(c, rate) : fromGross(c, rate);
    return { netto: toDecimalString(r.netto), vat: toDecimalString(r.vat), brutto: toDecimalString(r.brutto) };
  } catch {
    return null;
  }
}

export function CostFormModal(props: {
  cost?: Cost;
  initial?: Partial<CostDraft>;
  /** koszt dodawany z karty auta */
  lockCarId?: string;
  onClose: () => void;
  onSaved: (c: Cost) => void;
}) {
  const { cost, onClose, onSaved } = props;
  const app = useApp();
  const toast = useToast();
  const canEdit = app.can('costs.edit') && !cost?.cancelledAt;
  const categories = app.meta.costCategories.filter((c) => c.active || c.id === cost?.categoryId);
  const rates = app.meta.vatRates;
  const [v, setV] = useState<CostDraft>(() => ({
    data: today(),
    opis: '',
    categoryId: '',
    carId: props.lockCarId ?? '',
    vatRateId: rates.find((r) => Number(r.rate) === 0)?.id ?? '',
    kwota: '',
    kwotaTyp: 'brutto',
    sposobPlatnosci: 'gotowka',
    czyFaktura: false,
    numerFaktury: '',
    vatDoOdliczenia: null,
    notatka: '',
    ...(cost ? fromCost(cost) : {}),
    ...props.initial,
  }));
  // klucz formularza: ten sam przy ponownym wysłaniu tych samych danych (np. po zerwanym połączeniu),
  // nowy — gdy dane zmieniono (inaczej serwer zwróciłby wcześniej zapisany koszt)
  const [keyState, setKeyState] = useState<{ fp: string; key: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cars = useLoad(() => api.get<CarList>('/api/cars?view=all&limit=500&sort=numer&dir=desc'), []);

  // przy edycji z tą samą stawką liczymy stawką zapisaną w koszcie (jak serwer)
  const keepRate = cost && cost.vatRateId && v.vatRateId === cost.vatRateId ? cost.stawkaVat : null;
  const rate = keepRate ?? rates.find((r) => r.id === v.vatRateId)?.rate ?? '0';
  const archivedRate = cost?.vatRateId && !rates.some((r) => r.id === cost.vatRateId) ? cost : null;
  const beforeKasa = !!app.meta.kasaOd && v.sposobPlatnosci === 'gotowka' && !!v.data && v.data < app.meta.kasaOd;
  const calc = useMemo(() => preview(v.kwota, v.kwotaTyp, rate), [v.kwota, v.kwotaTyp, rate]);
  const vatPositive = !!calc && toCents(calc.vat) > 0n;
  const vatDoOdliczenia = v.vatDoOdliczenia ?? (v.czyFaktura && vatPositive);

  const set = <K extends keyof CostDraft>(k: K, val: CostDraft[K]) => setV((s) => ({ ...s, [k]: val }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setFormError('');
    const body = {
      data: v.data,
      opis: v.opis,
      categoryId: v.categoryId,
      carId: v.carId || null,
      vatRateId: v.vatRateId || null,
      kwota: v.kwota,
      kwotaTyp: v.kwotaTyp,
      sposobPlatnosci: v.sposobPlatnosci,
      czyFaktura: v.czyFaktura,
      numerFaktury: v.czyFaktura ? v.numerFaktury : null,
      vatDoOdliczenia,
      notatka: v.notatka,
    };
    const fp = JSON.stringify(body);
    const clientKey = keyState && keyState.fp === fp ? keyState.key : newKey();
    if (!cost) setKeyState({ fp, key: clientKey });
    try {
      const saved = cost
        ? await api.patch<Cost>(`/api/costs/${cost.id}`, { ...body, version: cost.version })
        : await api.post<Cost>('/api/costs', { ...body, clientKey });
      const kasaNote = !cost && saved.wplywNaKase !== '0.00' ? ` · kasa ${money(saved.wplywNaKase)}` : '';
      toast(cost ? `Zapisano koszt nr ${saved.numer}` : `Dodano koszt nr ${saved.numer}${kasaNote}`);
      onSaved(saved);
    } catch (err) {
      const ae = err as ApiError;
      setErrors(ae.fields ?? {});
      setFormError(ae.message);
    } finally {
      setBusy(false);
    }
  }

  async function cancelCost() {
    if (!cost) return;
    setBusy(true);
    try {
      const saved = await api.post<Cost>(`/api/costs/${cost.id}/cancel`, { version: cost.version });
      toast(`Anulowano koszt nr ${saved.numer}` + (cost.sposobPlatnosci === 'gotowka' ? ' · gotówka wróciła do kasy (korekta)' : ''));
      onSaved(saved);
    } catch (err) {
      setFormError((err as Error).message);
      setConfirmCancel(false);
    } finally {
      setBusy(false);
    }
  }

  const title = cost ? `Koszt nr ${cost.numer}${cost.cancelledAt ? ' (anulowany)' : ''}` : 'Nowy koszt';
  const lockedCar = props.lockCarId ? cars.data?.items.find((c) => c.id === props.lockCarId) : undefined;

  return (
    <Modal title={title} onClose={onClose} wide>
      <form onSubmit={submit} className="form cost-form" noValidate>
        <fieldset className="form-section" disabled={!canEdit}>
          <div className="form-grid">
            <Field label="Kwota (zł) *" error={errors.kwota}>
              <div className="amount-row">
                <input
                  inputMode="decimal"
                  autoFocus={!cost}
                  placeholder="0,00"
                  value={v.kwota}
                  onChange={(e) => set('kwota', e.target.value)}
                  aria-label="Kwota"
                />
                <div className="seg" role="group" aria-label="Rodzaj kwoty">
                  {(['brutto', 'netto'] as const).map((t) => (
                    <button type="button" key={t} className={v.kwotaTyp === t ? 'on' : ''} onClick={() => set('kwotaTyp', t)}>
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            </Field>
            <Field label="Stawka VAT" error={errors.vatRateId}>
              <select value={v.vatRateId} onChange={(e) => set('vatRateId', e.target.value)}>
                {rates.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
                {archivedRate && (
                  <option value={archivedRate.vatRateId!}>{`${(Number(archivedRate.stawkaVat) * 100).toLocaleString('pl-PL')}% (archiwalna)`}</option>
                )}
              </select>
            </Field>
            <div className="calc-line" aria-live="polite">
              {calc ? (
                <>
                  <span>
                    netto <strong>{money(calc.netto)}</strong>
                  </span>
                  <span>
                    VAT <strong>{money(calc.vat)}</strong>
                  </span>
                  <span>
                    brutto <strong>{money(calc.brutto)}</strong>
                  </span>
                </>
              ) : (
                <span className="muted">Wpisz kwotę — netto, VAT i brutto policzą się same.</span>
              )}
            </div>

            <Field label="Sposób płatności *" error={errors.sposobPlatnosci} wide>
              <div className="chips pay-chips" role="group" aria-label="Sposób płatności">
                {(Object.keys(PAYMENT_METHODS) as PaymentMethod[]).map((p) => (
                  <button type="button" key={p} className={'chip' + (v.sposobPlatnosci === p ? ' on' : '')} onClick={() => set('sposobPlatnosci', p)}>
                    {p === 'gotowka' && <Icon name="wallet" size={14} />} {PAYMENT_METHODS[p]}
                  </button>
                ))}
              </div>
              <span className="field-hint">
                {beforeKasa
                  ? `Data przed rozpoczęciem kasy (${date(app.meta.kasaOd)}) — ten koszt nie zmieni kasy, bo jest już w saldzie początkowym.`
                  : v.sposobPlatnosci === 'gotowka'
                  ? calc
                    ? `Gotówka: kasa zmniejszy się automatycznie o ${money(calc.brutto)}.`
                    : 'Gotówka: kwota zostanie automatycznie odjęta z kasy.'
                  : 'Ten sposób płatności nie zmienia stanu kasy gotówkowej.'}
                {cost && cost.sposobPlatnosci === 'gotowka' && ' Zmiana kwoty lub sposobu płatności doda korektę w kasie.'}
              </span>
            </Field>

            <Field label="Opis *" error={errors.opis} wide>
              <input value={v.opis} onChange={(e) => set('opis', e.target.value)} placeholder="np. Transport z Niemiec, paliwo, wymiana opon" maxLength={300} />
            </Field>
            <Field label="Kategoria *" error={errors.categoryId}>
              <select value={v.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
                <option value="">— wybierz —</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Data *" error={errors.data}>
              <input type="date" value={v.data} onChange={(e) => set('data', e.target.value)} />
            </Field>
            <Field label="Samochód" error={errors.carId} wide hint={props.lockCarId ? undefined : 'Pozostaw puste dla kosztu ogólnego firmy'}>
              {props.lockCarId ? (
                <input value={lockedCar ? lockedCar.label : cost?.car?.label ?? '…'} disabled />
              ) : (
                <select value={v.carId} onChange={(e) => set('carId', e.target.value)}>
                  <option value="">Koszt ogólny firmy (bez auta)</option>
                  {cost?.carId && !cars.data?.items.some((c) => c.id === cost.carId) && (
                    <option value={cost.carId}>{cost.car?.label ?? 'auto niedostępne'}</option>
                  )}
                  {cars.data?.items.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                      {c.numerRejestracyjny ? ` · ${c.numerRejestracyjny}` : ''}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
        </fieldset>

        <fieldset className="form-section" disabled={!canEdit}>
          <legend>Faktura i notatka</legend>
          <div className="form-grid">
            <label className="check-field">
              <input type="checkbox" checked={v.czyFaktura} onChange={(e) => set('czyFaktura', e.target.checked)} />
              <span>Jest faktura</span>
            </label>
            {v.czyFaktura && (
              <Field label="Numer faktury" error={errors.numerFaktury}>
                <input value={v.numerFaktury} onChange={(e) => set('numerFaktury', e.target.value)} placeholder="np. FV/12/10/2026" />
              </Field>
            )}
            {v.czyFaktura && vatPositive && (
              <label className="check-field">
                <input type="checkbox" checked={vatDoOdliczenia} onChange={(e) => set('vatDoOdliczenia', e.target.checked)} />
                <span>VAT do odliczenia</span>
              </label>
            )}
            <Field label="Notatka" error={errors.notatka} wide>
              <textarea rows={2} value={v.notatka} onChange={(e) => set('notatka', e.target.value)} />
            </Field>
          </div>
        </fieldset>

        {cost && (
          <p className="muted small">
            Dodał(a): {cost.createdBy ?? '—'} · wersja {cost.version}
            {cost.sposobPlatnosci === 'gotowka' || cost.wplywNaKase !== '0.00' ? ` · wpływ na kasę: ${money(cost.wplywNaKase)}` : ''}
            {cost.cancelledAt && ' · koszt anulowany — zostaje w historii'}
          </p>
        )}

        {formError && (
          <div className="error-box" role="alert">
            <Icon name="alert" />
            <span>{formError}</span>
          </div>
        )}
        <div className="form-actions">
          {cost && canEdit && (
            <div className="form-actions-left">
              {confirmCancel ? (
                <>
                  <span className="small">Anulować koszt?</span>
                  <button type="button" className="btn btn-ghost btn-sm danger" disabled={busy} onClick={() => void cancelCost()}>
                    Tak, anuluj koszt
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmCancel(false)}>
                    Nie
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmCancel(true)}>
                  Anuluj koszt…
                </button>
              )}
            </div>
          )}
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {canEdit ? 'Zamknij' : 'Zamknij'}
          </button>
          {canEdit && (
            <button className="btn btn-primary" disabled={busy}>
              {busy ? 'Zapisywanie…' : cost ? 'Zapisz zmiany' : 'Dodaj koszt'}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
