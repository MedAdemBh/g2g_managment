# ARC Raiders G2G NEXUS — Multi-Seller Coordination & Anti-Collision System

A specialized web application built for **ARC Raiders G2G marketplace sellers and suppliers**. It coordinates stock offered by users and prevents multiple sellers from accidentally claiming, listing, or double-selling the same item on G2G.

---

## 👥 Roles & Users

- **Sellers (2)**:
  - **Adem** (Seller 1)
  - **Amine** (Seller 2)
  *(Sellers configure their own custom fee rates ($ fixed or % markup), review available user offers, claim items to sell on G2G, and unlock them if stepping away or turning off their PC).*

- **Suppliers / Users (2)**:
  - **Aymen** (Supplier / User)
  - **Hmayma** (Supplier / User)
  *(Users deposit their ARC Raiders items with their desired target payout price without needing to manage G2G listings themselves).*

---

## 🎮 Game & Catalog

- **Game**: **ARC Raiders** exclusively.
- **Preloaded Catalog**: Over 200 items across all categories (Weapons, Blueprints, Materials, Keys, Augments, Ammo, Consumables, Gadgets) parsed directly from the in-game inventory list. Users can pick from the catalog or type custom items.

---

## 🚀 Key Features

1. **Clear Topic Tabs**:
   - 📦 **User Offers (Available)**: In-stock items offered by Aymen & Hmayma waiting for a seller to pick them up.
   - 🔒 **Taken Items & Anti-Collision**: Active items claimed by Adem or Amine. Live warning badges prevent the other seller from taking the same item.
   - 💰 **Completed Sales**: Record of sold items with order IDs, net supplier payout, and seller fee profit.
   - ⚡ **Activity & Logs**: Real-time audit trail of claims, releases, and sales.

2. **PC Shutdown / Disconnect Unlocking**:
   - If a seller claims an item but needs to close their PC or step away, they can click **"Unlock & Release"** to return the item to the available pool so the other seller can claim and sell it immediately.

3. **Per-Seller Configurable Fees (Default 10%)**:
   - Each seller (Adem / Amine) fixes their own fee policy (defaulted to 10%) directly in their profile strip, with automatic calculation of recommended G2G listing prices and live net profit previews when marking items sold.

4. **Withdraw Money Feature ($1.00 + 5% Fee)**:
   - Any member with an active balance can withdraw their funds.
   - **Fee calculation**: **$1.00 flat fee + 5% of the total amount withdrawn**.
     - Example: Withdrawing $100.00 incurs a $6.00 fee ($1.00 + $5.00), resulting in a net payout of $94.00.
   - Includes live calculation previews, "Max Balance" quick-fill, and a persistent withdrawal ledger in the Team & Balances tab.

5. **Real-Time WebSocket Synchronization**:
   - Zero manual page refreshing. When Adem claims an item in one window, Amine's screen instantly reflects the lock with an amber alert and disables the claim action.

---

## 🛠️ How to Run

1. Open your terminal in this project folder:
   ```bash
   cd "c:\Users\MSI\Desktop\g2g management"
   ```

2. Start the server (runs on `http://localhost:3000`):
   ```bash
   npm start
   ```

3. Open your browser and navigate to:
   ```
   http://localhost:3000
   ```

---

## 🧪 Testing the 2-Seller Flow

1. Open **Two Browser Windows** side-by-side at `http://localhost:3000`.
2. In **Window 1**, select **Adem (Seller 1)**.
3. In **Window 2**, select **Amine (Seller 2)**.
4. In **Window 1 (Adem)**, click **"Take & Sell on G2G"** on any available offer.
5. In **Window 2 (Amine)**, the item instantly moves to **"Taken Items"** with a badge indicating it is locked by Adem.
6. If Adem closes his PC, he clicks **"Unlock & Release"**, instantly returning the item to the available pool for Amine.
7. Once sold on G2G, the claiming seller clicks **"Mark as Sold"**, enters the final selling price & G2G Order ID, and completes the transaction!
