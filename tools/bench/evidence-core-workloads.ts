import {writeFileSync,mkdirSync} from "node:fs";
import {join} from "node:path";
export const mixedLanguages=["ts","java","py","go","rs"] as const;
/** Synthetic static-analysis workload, not a language conformance or runtime oracle. */
export function populateMixed(root:string,perLanguage=100):void {
  mkdirSync(root,{recursive:true});
  for(let i=0;i<perLanguage;i++){
    const files:Record<string,string>={
      ts:`export function helper${i}(amount:number){return amount+${i};}\nexport function apply${i}(amount:number){const balance=helper${i}(amount);if(balance<0)throw new Error("negative");return balance;}\n`,
      java:`public class Account${i} { private int balance; public int apply(int amount){balance=helper(amount);if(balance<0)throw new IllegalArgumentException();return balance;} private int helper(int amount){return amount+${i};} }\n`,
      py:`class Account${i}:\n    def helper(self, amount):\n        return amount + ${i}\n    def apply(self, amount):\n        self.balance = self.helper(amount)\n        if self.balance < 0:\n            raise ValueError("negative")\n        return self.balance\n`,
      go:`package mixed\ntype Account${i} struct { Balance int }\nfunc (a *Account${i}) Apply(amount int) int { a.Balance = helper${i}(amount); return a.Balance }\nfunc helper${i}(amount int) int { return amount + ${i} }\n`,
      rs:`pub struct Account${i} { pub balance: i64 }\nimpl Account${i} { pub fn apply(&mut self, amount: i64) -> i64 { self.balance = helper${i}(amount); self.balance } }\npub fn helper${i}(amount: i64) -> i64 { amount + ${i} }\n`,
    };
    for(const ext of mixedLanguages)writeFileSync(join(root,`${i}.${ext}`),files[ext]);
  }
}
