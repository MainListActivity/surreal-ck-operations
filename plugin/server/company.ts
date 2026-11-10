import { loadServiceEnv } from './env';
import type { PaseoApi } from '@getpaseo/client';
import { installBunShim } from './bun-shim';
import { createPaseoCli } from './vendor/src/dispatcher/paseo.ts';
import { setAgentModel } from './vendor/src/dispatcher/agent-model.ts';
import { company as boot, currentCompany as current, configureCompanyRuntime, noteHost, currentHost } from './vendor/src/runner/company.ts';
import type { Company as RuntimeCompany } from './vendor/src/runner/company.ts';
import type { RuntimeHost } from './vendor/src/runner/host.ts';
installBunShim();
loadServiceEnv();
configureCompanyRuntime({ gateway: createPaseoCli(), realign: setAgentModel,
  runner: { id: process.env.SCK_RUNNER_ID ?? 'paseo:legacy', adoptLegacy: process.env.SCK_RUNNER_ADOPT_LEGACY !== '0' } });
export type Company = Omit<RuntimeCompany, 'paseo'> & { paseo: PaseoApi | undefined };
export const company = () => boot() as Promise<Company>;
export const currentCompany = () => current() as Company | undefined;
export const notePaseo = (api: PaseoApi | undefined) => noteHost(api as unknown as RuntimeHost | undefined);
export const currentPaseo = () => currentHost() as unknown as PaseoApi | undefined;
