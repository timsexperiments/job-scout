export function protectApplicationFacts(draft: string, phrases: string[]) {
  let text=draft;
  const facts=phrases.map((phrase,index)=>({phrase,marker:`[SCOUT_FACT_${index}]`}));
  for(const fact of facts){
    if(!text.includes(fact.phrase))throw new Error("Reviewed application brief is missing a required fact");
    text=text.replaceAll(fact.phrase,fact.marker);
  }
  return {text,restore(edited:string){
    let result=edited;
    for(const fact of facts)result=result.replaceAll(fact.marker,fact.phrase);
    return facts.every(fact=>result.includes(fact.phrase)) && !/\[SCOUT_FACT_\d+\]/.test(result) && !result.includes("—") ? result : draft;
  }};
}
