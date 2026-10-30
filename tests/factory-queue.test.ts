import {expect,test} from 'bun:test';
import {factoryQueue,leaveFactoryQueue,FACTORY_WAIT_LIMIT} from '../src/dispatcher/provider-order.ts';

test('the first three oldest jobs stay reserved across restarts and arrival of newer work',()=>{
 const jobs=[{key:'second',createdAt:2},{key:'first',createdAt:1},{key:'third',createdAt:3},{key:'fourth',createdAt:4}];
 const q=factoryQueue(jobs);
 expect([...q].filter(([,n])=>n<=FACTORY_WAIT_LIMIT).map(([k])=>k)).toEqual(['first','second','third']);
 expect([...factoryQueue([...jobs].reverse())]).toEqual([...q]);
 expect([...factoryQueue([...jobs,{key:'newer',createdAt:5}])].slice(0,3)).toEqual([...q].slice(0,3));
 leaveFactoryQueue(q,'first');expect(q.get('fourth')).toBe(3);
 leaveFactoryQueue(q,'missing');expect([...q.values()]).toEqual([1,2,3]);
});
