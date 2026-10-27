import {z} from 'zod';
import {turnMetricsSchema} from './agent-metrics';
export const modelSwitchSchema=z.object({
 from:z.string().min(1).max(300),to:z.string().min(1).max(300),at:z.number().finite().nonnegative(),
 previous:turnMetricsSchema,
});
export type ModelSwitch=z.output<typeof modelSwitchSchema>;
