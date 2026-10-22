/** Typy odpowiedzi API wspólne dla serwera i interfejsu. Kwoty: string "1234.56". */

export type StatusKind = 'logistic' | 'sales' | 'settlement';

export interface CarStatus {
  id: string;
  kind: StatusKind;
  systemCode: string | null;
  name: string;
  color: string;
  sortOrder: number;
  isClosed: boolean;
  isDefault: boolean;
  active: boolean;
}

export interface Country {
  code: string;
  name: string;
  currency: string | null;
  active: boolean;
}

export interface CarFinance {
  wartoscAuta: string | null;
  walutaZakupu: string;
  cenaZakupuWaluta: string | null;
  kursWaluty: string | null;
  uslugiAukcjiNetto: string | null;
  vatNaUslugi: string | null;
  akcyzaPcc: string | null;
  trybZakupu: string | null;
  trybSprzedazy: string | null;
  kwotaNabyciaVatMarza: string | null;
  cenaSprzedazyFaktyczna: string | null;
  /** Etap 3: suma kosztów przypisanych do auta (brutto) */
  kosztyRazem: string | null;
  /** Prognoza wstępna: Cena A − wartość auta − koszty (przed podatkami; pełne rozliczenie w Etapie 4) */
  zyskAPrognoza: string | null;
  zyskBPrognoza: string | null;
}

export interface Car {
  id: string;
  numer: number;
  label: string; // "37 — Volkswagen Tiguan 2011"
  marka: string;
  model: string;
  wersja: string | null;
  rokProdukcji: number | null;
  vin: string | null;
  numerRejestracyjny: string | null;
  przebiegKm: number | null;
  pojemnoscCm3: number | null;
  mocKm: number | null;
  rodzajPaliwa: string | null;
  skrzyniaBiegow: string | null;
  kolor: string | null;
  dataZakupu: string | null;
  dataPrzyjazdu: string | null;
  dataSprzedazy: string | null;
  typZakupu: string | null;
  krajZakupu: string | null;
  krajRejestracji: string | null;
  krajLokalizacji: string | null;
  krajSprzedawcy: string | null;
  krajFaktury: string | null;
  cenaA: string | null;
  cenaB: string | null;
  logisticStatusId: string;
  salesStatusId: string;
  settlementStatusId: string;
  /** Status wyświetlany: Rozliczone (jeśli rozliczone) albo status logistyczny */
  displayStatusId: string;
  notatka: string | null;
  mainPhotoUrl: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Obecne tylko, gdy użytkownik ma uprawnienie cars.finance.view */
  finance?: CarFinance;
}

export interface CarList {
  items: Car[];
  total: number;
}

export interface StatusHistoryEntry {
  kind: StatusKind;
  fromStatusId: string | null;
  toStatusId: string;
  changedAt: string;
  changedBy: string | null;
}

export interface Me {
  user: { id: string; email: string; fullName: string };
  workspace: { id: string; code: string; name: string };
  role: string;
  roleName: string;
  /** Hasło tymczasowe — interfejs wymusza zmianę przed pracą */
  mustChangePassword: boolean;
  permissions: string[];
  /** 'test' — baner „tryb testowy, nie wprowadzaj prawdziwych danych” */
  mode: 'test' | 'production';
  environment: string | null;
}

export interface DashboardData {
  counts: {
    wSprzedazy: number;
    wDrodze: number;
    serwis: number;
    lakiernia: number;
    naPlacu: number;
    problem: number;
    aktywne: number;
    rozliczone: number;
  };
  byStatus: Array<{ statusId: string; count: number }>;
  /** null = brak uprawnień do danych finansowych */
  finance: null | {
    wartoscAut: string;
    kosztyAktywnych: string;
    zyskOczekiwany: string;
    zyskOczekiwanyLiczbaAut: number;
    zyskFaktyczny: string;
    zyskFaktycznyLiczbaAut: number;
  };
  kosztyRazem: string | null;
  kasa: null | {
    aktualna: string;
    ostatnieOperacje: Array<{
      id: string;
      numer: number;
      data: string;
      typ: string;
      kwota: string;
      opis: string;
      carNumer: number | null;
      saldoPoOperacji: string;
    }>;
  };
  recentCars: Car[];
}

export interface Meta {
  statuses: CarStatus[];
  countries: Country[];
  costCategories: CostCategory[];
  vatRates: VatRate[];
  fuelTypes: string[];
  gearboxTypes: string[];
  purchaseTypes: string[];
}

export const FUEL_TYPES = ['Benzyna', 'Diesel', 'Benzyna + LPG', 'Hybryda', 'Hybryda plug-in', 'Elektryczny', 'Inne'];
export const GEARBOX_TYPES = ['Manualna', 'Automatyczna'];
export const PURCHASE_TYPES = ['Aukcja', 'Firma', 'Osoba prywatna', 'Leasing', 'Komis', 'Inne'];

export function carLabel(c: { numer: number; marka: string; model: string; rokProdukcji: number | null }) {
  return `${c.numer} — ${c.marka} ${c.model}${c.rokProdukcji ? ' ' + c.rokProdukcji : ''}`;
}

// ---------------------------------------------------------------------------
// Etap 3: Koszty i Kasa
// ---------------------------------------------------------------------------

export type PaymentMethod = 'gotowka' | 'przelew' | 'karta' | 'inne';
export const PAYMENT_METHODS: Record<PaymentMethod, string> = {
  gotowka: 'Gotówka',
  przelew: 'Przelew',
  karta: 'Karta',
  inne: 'Inne',
};

export interface CostCategory {
  id: string;
  systemCode: string | null;
  name: string;
  active: boolean;
}

export interface VatRate {
  id: string;
  label: string;
  /** "0.2300" */
  rate: string;
  active: boolean;
}

export interface CarRef {
  id: string;
  numer: number;
  label: string;
}

export interface Cost {
  id: string;
  numer: number;
  data: string;
  opis: string;
  categoryId: string;
  categoryName: string;
  vatRateId: string | null;
  stawkaVat: string;
  kwotaNetto: string;
  kwotaVat: string;
  kwotaBrutto: string;
  vatDoOdliczenia: boolean;
  sposobPlatnosci: PaymentMethod;
  czyFaktura: boolean;
  numerFaktury: string | null;
  notatka: string | null;
  /** null = koszt ogólny firmy (albo auto niewidoczne dla tej roli) */
  car: CarRef | null;
  carId: string | null;
  version: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  /** Suma operacji kasowych tego kosztu (np. "-1500.00"); "0.00" przy przelewie */
  wplywNaKase: string;
}

export interface CostList {
  items: Cost[];
  total: number;
  sum: { netto: string; vat: string; brutto: string; gotowka: string };
}

export type KasaTyp = 'przychod' | 'wydatek' | 'korekta' | 'wplata' | 'wyplata';
export const KASA_TYPES: Record<KasaTyp, string> = {
  wplata: 'Wpłata',
  wyplata: 'Wypłata',
  przychod: 'Przychód',
  wydatek: 'Wydatek',
  korekta: 'Korekta',
};
/** Typy, które można dodać ręcznie (wydatek gotówkowy — tylko przez Koszty) */
export const KASA_MANUAL_TYPES: KasaTyp[] = ['wplata', 'wyplata', 'przychod', 'korekta'];

export interface KasaOperation {
  id: string;
  numer: number;
  data: string;
  typ: KasaTyp;
  kwota: string;
  opis: string;
  car: CarRef | null;
  costId: string | null;
  costNumer: number | null;
  saldoPoOperacji: string;
  createdBy: string | null;
  createdAt: string;
}

export interface KasaView {
  saldoPoczatkowe: string;
  dataPoczatkowa: string;
  aktualna: string;
  /** Saldo początkowe można zmienić tylko przed pierwszą operacją */
  canSetInitial: boolean;
  items: KasaOperation[];
  total: number;
  /** Sumy w wybranym okresie */
  wplywy: string;
  wyplywy: string;
}
