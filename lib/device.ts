// Shared, client-safe device types/constants for the adaptive shell. NO server
// imports here (no next/headers) so this module is safe to pull into the client
// DeviceProvider bundle. The cookie carries ONLY the form factor and is never
// trusted for authorization — it just removes the first-render flash.
export type Device = "mobile" | "desktop";

export const DEVICE_COOKIE = "df_device";
