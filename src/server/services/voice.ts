/**
 * Wprowadzanie kosztu głosem: tekst (z dyktowania) → Claude wyciąga pola → serwer weryfikuje i dopasowuje auto.
 * Zwraca PROPOZYCJĘ do formularza; zapis wykonuje użytkownik zwykłym formularzem kosztu (POST /api/costs).
 */
import { z } from 'zod';
import { toCents, toDecimalString } from '../../shared/money.ts';
import { carLabel, type CarRef, type CostVoiceResult, type PaymentMethod } from '../../shared/types.ts';
import { HttpError } from '../http/core.ts';
import { type AnthropicConfig, CostParserError, type ParsedCost, parseCostWithClaude } from '../integrations/anthropic/cost-parser.ts';
import { type Ctx, requirePerm } from './context.ts';
import { parseOrThrow } from './cars.ts';
import { entryDate } from './costs.ts';

const MAX_CENTS = 100_000_000_00n;

/** Limit kosztów API: 30 rozpoznań na 10 minut na użytkownika */
const hits = new Map<string, number[]>();
function allow(userId: string, now = Date.now()) {
  const list = (hits.get(userId) ?? []).filter((t) => now - t < 10 * 60 * 1000);
  if (list.length >= 30) {
    hits.set(userId, list);
    return false;
  }
  list.push(now);
  hits.set(userId, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 10 * 60 * 1000)) hits.delete(k);
  return true;
}

export const parseSchema = z.object({ text: z.string().trim().min(3, 'Powiedz lub wpisz, co to za koszt').max(600, 'Zbyt długi tekst (max 600 znaków)') }).strict();

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m);

async function findCars(ctx: Ctx, where: string, params: unknown[]): Promise<CarRef[]> {
  const { rows } = await ctx.q.query<{ id: string; numer: string; marka: string; model: string; rok_produkcji: number | null }>(
    `SELECT id, numer, marka, model, rok_produkcji FROM cars WHERE deleted_at IS NULL AND ${where} ORDER BY numer DESC LIMIT 6`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    numer: Number(r.numer),
    label: carLabel({ numer: Number(r.numer), marka: r.marka, model: r.model, rokProdukcji: r.rok_produkcji }),
  }));
}

/** Dopasowanie auta w bazie (RLS: tylko auta widoczne dla użytkownika). Kolejność: numer → rejestracja → VIN → marka/model. */
async function resolveCar(ctx: Ctx, auto: ParsedCost['auto']): Promise<CostVoiceResult['car']> {
  if (!auto) return { status: 'none', candidates: [], said: null };
  const said = [
    auto.numer != null ? `nr ${auto.numer}` : null,
    auto.rejestracja,
    auto.vin_koncowka ? `VIN …${auto.vin_koncowka}` : null,
    auto.marka_model,
  ]
    .filter(Boolean)
    .join(', ')
    .slice(0, 120);
  if (!said) return { status: 'none', candidates: [], said: null };
  const attempts: Array<() => Promise<CarRef[]>> = [];
  if (Number.isInteger(auto.numer) && auto.numer! > 0 && auto.numer! < 10_000_000) {
    attempts.push(() => findCars(ctx, 'numer = $1', [auto.numer]));
  }
  const reg = (auto.rejestracja ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (reg.length >= 4 && reg.length <= 12) {
    attempts.push(() => findCars(ctx, "regexp_replace(upper(coalesce(numer_rejestracyjny, '')), '[^A-Z0-9]', '', 'g') = $1", [reg]));
  }
  const vin = (auto.vin_koncowka ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (vin.length >= 4 && vin.length <= 17) attempts.push(() => findCars(ctx, "upper(coalesce(vin, '')) LIKE $1", ['%' + escapeLike(vin)]));
  const words = (auto.marka_model ?? '')
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}-]/gu, ''))
    .filter((w) => w.length >= 2)
    .slice(0, 3);
  if (words.length) {
    attempts.push(() =>
      findCars(
        ctx,
        words.map((_, i) => `(marka || ' ' || model || ' ' || coalesce(wersja, '')) ILIKE $${i + 1}`).join(' AND '),
        words.map((w) => `%${escapeLike(w)}%`),
      ),
    );
  }
  for (const attempt of attempts) {
    const found = await attempt();
    if (found.length === 1) return { status: 'found', candidates: found, said };
    if (found.length > 1) return { status: 'ambiguous', candidates: found.slice(0, 5), said };
  }
  return { status: 'not_found', candidates: [], said };
}

export async function parseCostText(ctx: Ctx, cfg: AnthropicConfig | null, input: unknown): Promise<CostVoiceResult> {
  requirePerm(ctx, 'costs.view', 'costs.edit');
  if (!cfg) throw new HttpError(404, 'Wprowadzanie głosowe nie jest włączone (brak klucza ANTHROPIC_API_KEY)', 'voice_disabled');
  const { text } = parseOrThrow(parseSchema, input);
  if (!allow(ctx.session.userId)) throw new HttpError(429, 'Zbyt wiele rozpoznań w krótkim czasie. Spróbuj za kilka minut.');

  const { rows: cats } = await ctx.q.query<{ id: string; code: string; name: string }>(
    "SELECT id, coalesce(system_code, id::text) AS code, name FROM cost_categories WHERE active ORDER BY sort_order, name",
  );
  const { rows: rates } = await ctx.q.query<{ id: string; label: string }>(
    `SELECT id, label FROM vat_rates WHERE active AND valid_from <= (now() AT TIME ZONE 'Europe/Warsaw')::date
       AND (valid_to IS NULL OR valid_to >= (now() AT TIME ZONE 'Europe/Warsaw')::date) ORDER BY sort_order`,
  );
  const { rows: t } = await ctx.q.query<{ d: string }>("SELECT (now() AT TIME ZONE 'Europe/Warsaw')::date::text AS d");
  const today = t[0].d;

  let parsed: ParsedCost;
  try {
    parsed = await parseCostWithClaude(cfg, text, {
      today,
      categories: cats.map((c) => ({ code: c.code, name: c.name })),
      vatLabels: rates.map((r) => r.label),
    });
  } catch (e) {
    if (e instanceof CostParserError) throw new HttpError(502, e.message + ' Możesz wpisać koszt ręcznie.', 'voice_failed');
    throw e;
  }

  const uwagi: string[] = [];
  const draft: CostVoiceResult['draft'] = {};
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

  // kwota — tylko poprawna, dodatnia, z najwyżej 2 miejscami po przecinku
  const kwota = str(parsed.kwota, 30);
  if (kwota) {
    try {
      const c = toCents(kwota);
      if (c > 0n && c <= MAX_CENTS) draft.kwota = toDecimalString(c).replace('.', ',').replace(/,00$/, '');
    } catch {
      /* niepoprawna — pole zostaje puste */
    }
  }
  if (!draft.kwota) uwagi.push('Nie rozpoznano kwoty — wpisz ją.');
  draft.kwotaTyp = parsed.kwota_typ === 'netto' ? 'netto' : 'brutto';

  const rate = rates.find((r) => r.label === parsed.stawka_vat);
  if (rate) draft.vatRateId = rate.id;

  const sposoby: PaymentMethod[] = ['gotowka', 'przelew', 'karta', 'inne'];
  if (parsed.sposob_platnosci && sposoby.includes(parsed.sposob_platnosci)) draft.sposobPlatnosci = parsed.sposob_platnosci;
  else uwagi.push('Nie podano sposobu płatności — sprawdź (domyślnie Gotówka zmniejsza kasę).');

  const cat = cats.find((c) => c.code === parsed.kategoria);
  if (cat) draft.categoryId = cat.id;
  else uwagi.push('Wybierz kategorię.');

  const data = str(parsed.data, 10);
  if (data && entryDate.safeParse(data).success) draft.data = data;
  else if (data) uwagi.push('Nie rozpoznano daty — ustawiono dzisiejszą.');

  const opis = str(parsed.opis, 300);
  if (opis && opis.length >= 2) draft.opis = opis;
  else if (cat) draft.opis = cat.name;

  if (parsed.czy_faktura === true) {
    draft.czyFaktura = true;
    const nr = str(parsed.numer_faktury, 100);
    if (nr) draft.numerFaktury = nr;
  }

  const car = await resolveCar(ctx, parsed.auto && typeof parsed.auto === 'object' ? parsed.auto : null);
  if (car.status === 'found') draft.carId = car.candidates[0].id;
  if (car.status === 'ambiguous') uwagi.push(`Pasuje kilka aut (${car.said}) — wybierz właściwe z listy.`);
  if (car.status === 'not_found') uwagi.push(`Nie znaleziono auta „${car.said}” — wybierz z listy albo zostaw jako koszt firmy.`);

  return { text, draft, car, uwagi };
}
