// Links between agents and IdentityMD NFTs.
//
// SIMULATED: a real deployment would read, from the IdentityMD NFT contract,
// which agent key each token is bound to (for example a binding set by the
// token owner's wallet). This prototype reads the same mapping from a local
// JSON "registry" file instead of a chain. Every node should be given the same
// file, just as every node would read the same chain.
//
// Registry file format:
//   { "chain": "...", "contract": "0x...",
//     "tokens": { "<tokenId>": { "agent": "imd:ed25519:...", "owner": "0x..." } } }
import { existsSync, readFileSync } from 'node:fs';

export class NftRegistry {
  constructor(file) {
    this.file = file;
    this.data = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  }

  get source() {
    return this.data ? `simulated registry (${this.file})` : 'none configured';
  }

  // How a profile's NFT claim stands against the registry:
  //   none       - the profile makes no NFT claim
  //   verified   - the registry binds this token to this agent key
  //   mismatch   - the registry binds this token to a different agent key
  //   unverified - the claim cannot be checked (unknown contract or token, or no registry)
  status(author, profile) {
    const nft = profile?.nft;
    if (!nft) return { state: 'none' };
    const d = this.data;
    const sameContract = d && d.chain === nft.chain && d.contract?.toLowerCase() === nft.contract.toLowerCase();
    const token = sameContract ? d.tokens?.[nft.tokenId] : undefined;
    if (!token) return { state: 'unverified', nft };
    if (token.agent !== author) return { state: 'mismatch', nft, boundTo: token.agent };
    return { state: 'verified', nft, owner: token.owner };
  }
}
