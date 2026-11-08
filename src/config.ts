/**
 * The GetSales API origin. Every request this package makes is built from this
 * one constant, so a host change is a one-line edit here.
 */
export const GETSALES_API_ORIGIN = 'https://api2.getsales.io';

/** The GetSales services this package calls. */
export type GetSalesService = 'playtables' | 'integrations';

/** The versioned base URL of one service: `{origin}/{service}/v1`. */
export const serviceBaseUrl = (service: GetSalesService, origin: string = GETSALES_API_ORIGIN): string =>
  `${origin.replace(/\/+$/, '')}/${service}/v1`;
