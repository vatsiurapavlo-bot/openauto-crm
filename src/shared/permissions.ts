/** Jedno źródło listy uprawnień. Test sprawdza zgodność z init_workspace() w bazie. */
export const PERMISSIONS = {
  'dashboard.view': 'Dashboard',
  'cars.view': 'Podgląd samochodów',
  'cars.create': 'Dodawanie samochodów',
  'cars.edit': 'Edycja samochodów',
  'cars.status': 'Zmiana statusu',
  'cars.settle': 'Rozliczanie (przeniesienie do Rozliczone)',
  'cars.delete': 'Usuwanie samochodów (archiwizacja)',
  'cars.finance.view': 'Finanse samochodu — podgląd',
  'cars.finance.edit': 'Finanse samochodu — edycja',
  'costs.view': 'Koszty — podgląd',
  'costs.edit': 'Koszty — edycja',
  'kasa.view': 'Kasa — podgląd',
  'kasa.edit': 'Kasa — operacje',
  'finance.view': 'Finanse i VAT',
  'reports.view': 'Raporty',
  'documents.view': 'Dokumenty — podgląd',
  'documents.edit': 'Dokumenty — edycja',
  'import.auction': 'Import z aukcji',
  'users.manage': 'Użytkownicy i uprawnienia',
  'settings.manage': 'Ustawienia',
  'audit.view': 'Dziennik zmian',
  'backup.manage': 'Kopie zapasowe',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const ROLE_LABELS: Record<string, string> = {
  owner: 'Właściciel',
  administrator: 'Administrator',
  manager: 'Manager',
  sprzedawca: 'Sprzedawca',
  serwis: 'Serwis',
  lakiernia: 'Lakiernia',
  ksiegowosc: 'Księgowość',
  viewer: 'Podgląd',
};
