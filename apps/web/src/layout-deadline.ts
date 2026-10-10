/** A stalled worker must not leave the canvas permanently busy. */
export function layoutDeadline<T>(work:Promise<T>,timeoutMs=10000) {
 let timer:ReturnType<typeof setTimeout>;
 const promise=new Promise<T>((resolve,reject)=>{
  timer=setTimeout(()=>reject(new Error(`Graph layout exceeded ${timeoutMs}ms`)),timeoutMs);
  void work.then(resolve,reject).finally(()=>clearTimeout(timer));
 });
 return {promise,cancel:()=>clearTimeout(timer)};
}
