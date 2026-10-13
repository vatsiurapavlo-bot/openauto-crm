/**
 * Kontrakt adaptera aukcji (p. 15) — USTALONY W ETAPIE 1, implementacje w kolejnych etapach.
 *
 * Zasada: OpenAuto analizuje dane i liczy koszty, ale NIGDY nie licytuje, nie kupuje,
 * nie potwierdza zamówień i nie wysyła wiadomości. Dlatego interfejs celowo NIE ZAWIERA
 * żadnej metody zapisu — adapter, który chciałby to zrobić, nie ma jak tego wyrazić.
 *
 * Każdy adapter:
 *  - korzysta z oficjalnego API lub dozwolonej metody pobierania danych (do potwierdzenia
 *    osobno dla każdej platformy przed implementacją),
 *  - używa poświadczeń o minimalnych uprawnieniach (tylko odczyt), przechowywanych zaszyfrowanych,
 *  - nie obchodzi CAPTCHA ani ograniczeń dostępu,
 *  - zwraca null dla nieznanych pól — nie zgaduje wartości.
 */

export type AuctionFieldKey =
  | 'nazwaAukcji' | 'lotId' | 'url' | 'marka' | 'model' | 'wersja' | 'rokProdukcji' | 'vin' | 'przebiegKm'
  | 'paliwo' | 'pojemnoscCm3' | 'mocKm' | 'skrzyniaBiegow' | 'krajPochodzenia' | 'krajLokalizacji'
  | 'miejscowosc' | 'dataPierwszejRejestracji' | 'dataAukcji' | 'cenaAktualna' | 'cenaKupTeraz' | 'waluta'
  | 'vatStatus' | 'rodzajFaktury' | 'oplatyAukcyjne' | 'opisUszkodzen' | 'stanTechniczny';

/** Wartość z pochodzeniem — zapisywana w auction_import_fields. */
export interface ImportedValue {
  value: string | null;
  source: string; // np. 'openlane-api', 'reczny'
  fetchedAt: Date;
  isAutomatic: boolean;
}

export interface AuctionLot {
  fields: Partial<Record<AuctionFieldKey, ImportedValue>>;
  photos: Array<{ url: string; caption?: string }>;
  documents: Array<{ url: string; name: string }>;
}

export interface AuctionAdapter {
  /** Klucz zapisywany w auctions.adapter_key */
  readonly key: string;
  readonly displayName: string;
  /** Czy adres URL należy do tej platformy */
  matchesUrl(url: string): boolean;
  /** Pobranie danych losu — wyłącznie odczyt */
  fetchLot(url: string, signal?: AbortSignal): Promise<AuctionLot>;
}

/** Adapter „ręczny" — dostępny od razu: użytkownik wpisuje dane, system zapisuje ich źródło. */
export const manualAdapter: AuctionAdapter = {
  key: 'reczny',
  displayName: 'Wprowadzanie ręczne',
  matchesUrl: () => true,
  async fetchLot(url) {
    return {
      fields: { url: { value: url, source: 'reczny', fetchedAt: new Date(), isAutomatic: false } },
      photos: [],
      documents: [],
    };
  },
};
