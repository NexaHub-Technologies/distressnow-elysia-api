/**
 * DistressNow seed script — mirrors Laravel's database/seeders/*.
 *
 *   bun run db:seed
 *
 * Seeds:
 *   - roles            (admin, verifier, shop_manager, seller, provider, buyer)  → RolesAndPermissionsSeeder
 *   - categories       (16 categories + subcategories)                            → CategoriesSeeder
 *   - states           (36 + FCT, ~230 sublocations)                              → NigerianStatesSeeder
 *   - markets          (~2600, parsed from Laravel MarketSeeder.php at seed time) → MarketSeeder
 *   - staff users      (admin/verifier/shop_manager, pw 18781875)                 → StaffUsersSeeder
 *
 * The seed is idempotent (upsert-by-slug/email).
 */
import { and, desc, eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { db } from "./client";
import {
  categories,
  markets,
  modelHasRoles,
  roles,
  states,
  subcategories,
  sublocations,
  users,
} from "./schema";

const __dirname = dirname(fileURLToPath(import.meta.url));

const slugify = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");

async function seedRoles() {
  const roleNames = ["admin", "verifier", "shop_manager", "seller", "provider", "buyer"];
  for (const name of roleNames) {
    await db
      .insert(roles)
      .values({ name, guardName: "sanctum" })
      .onConflictDoNothing({ target: [roles.name, roles.guardName] });
  }
  console.log(`roles: seeded ${roleNames.join(", ")}`);
}

// ─── Categories (from CategoriesSeeder.php) ───────────────────────────────
const CATEGORY_DATA: Record<string, string[]> = {
  Electronics: ["Phones & Tablets", "Laptops & Computers", "TV & Audio", "Cameras", "Gaming", "Accessories", "Printers & Scanners", "Smart Watches", "Networking Equipment"],
  Vehicles: ["Cars", "Motorcycles & Tricycles", "Buses & Minibuses", "Trucks & Trailers", "Vehicle Parts", "Boats & Watercraft"],
  Property: ["Houses & Apartments for Sale", "Houses & Apartments for Rent", "Land & Plots", "Commercial Property", "Short-Let"],
  Fashion: ["Clothing", "Shoes", "Bags", "Watches", "Jewellery", "Wedding Wear & Accessories"],
  "Home & Garden": ["Furniture", "Home Accessories", "Kitchen & Dining", "Garden", "Lighting & Electrical", "Bedding & Bath"],
  Beauty: ["Hair Care", "Skincare", "Makeup", "Fragrances", "Bath & Body", "Tools & Accessories"],
  Health: ["Supplements", "Medical Equipment", "Personal Care", "Fitness Equipment", "Wellness Products"],
  Services: ["Electrician", "Solar & Inverter Installation", "Electrical Wiring", "Generator Repair", "CCTV & Security Systems", "Plumber", "Borehole Drilling & Repair", "Water Tank Installation", "Pipefitting & Drainage", "AC & Refrigeration Technician", "Appliance Repair (Washing Machine, Fridge, Microwave)", "Mechanic (Auto Repair)", "Auto Electrician", "Auto Panel Beater & Painter", "Vulcanizer & Tyre Service", "Car Wash & Auto Detailing", "Carpenter & Joiner", "Furniture Maker", "Upholstery & Sofa Repair", "POP Ceiling & Screeding", "Painter & Decorator", "Tiler", "Mason & Bricklayer", "Roofer & Truss Fabricator", "Welder & Metal Fabricator", "Aluminium & Glass Fabricator", "Interior Decorator & Designer", "House Cleaner & Janitor", "Fumigation & Pest Control", "Laundry & Dry Cleaning", "Gardener & Landscaping", "Waste Management", "Hair Stylist & Braider", "Barber", "Makeup Artist & Gele Tier", "Nail Technician & Pedicurist", "Spa & Massage Therapist", "Fashion Designer & Tailor", "Event Planner & Coordinator", "Chef & Catering Service", "Baker & Cake Decorator", "Event DJ & Sound Engineer", "Event MC & Host", "Photographer", "Videographer & Media Production", "Decorator & Event Rentals", "Driver & Chauffeur", "Moving & Relocation Service", "Dispatch & Courier Rider", "Towing Truck Service", "Computer & Laptop Repair", "Phone & Tablet Repair", "Web & Software Developer", "Graphic Designer & Brand Specialist", "Social Media Manager", "Network & IT Engineer", "Private Tutor & Academic Coach", "Music Teacher (Piano, Guitar, Vocal)", "Fitness Trainer & Gym Instructor", "Nurse & Home Caregiver", "Physiotherapist", "Legal Practitioner & Advisor", "Accountant & Tax Consultant", "Land & Property Surveyor", "Real Estate Agent & Broker", "Business Plan & CAC Registration Agent"],
  Construction: ["Building Materials", "Plumbing Materials", "Electrical Materials", "Doors & Windows", "Tiles & Flooring", "Roofing", "Iron & Steel"],
  Automotive: ["Car Parts", "Car Accessories", "Car Audio", "Tyres & Rims", "Car Care Products", "Tools"],
  Agriculture: ["Farm Machinery", "Livestock", "Seedlings & Seeds", "Farm Produce", "Fertilizers & Chemicals", "Fish & Aquaculture"],
  "Sports & Outdoors": ["Fitness", "Team Sports", "Outdoor Recreation", "Camping & Hiking", "Cycling"],
  "Baby & Kids": ["Baby Clothing", "Baby Gear", "Toys", "Feeding", "Kids Furniture", "School Supplies"],
  "Food & Drinks": ["Groceries", "Beverages", "Snacks", "Frozen Foods", "Fresh Produce", "Catering & Prepared Foods"],
  "Office & Business": ["Office Furniture", "Office Equipment", "Stationery", "POS & Payment Devices", "Packaging Materials"],
};

async function seedCategories() {
  let catSort = 0;
  for (const [catName, subNames] of Object.entries(CATEGORY_DATA)) {
    const [cat] = await db
      .insert(categories)
      .values({ name: catName, slug: slugify(catName), sortOrder: catSort++, isActive: true })
      .onConflictDoUpdate({ target: categories.slug, set: { name: catName, isActive: true } })
      .returning({ id: categories.id });
    if (!cat) continue;
    let subSort = 0;
    for (const subName of subNames) {
      await db
        .insert(subcategories)
        .values({ categoryId: cat.id, name: subName, slug: slugify(subName), sortOrder: subSort++, isActive: true })
        .onConflictDoNothing({ target: [subcategories.categoryId, subcategories.slug] });
    }
  }
  console.log(`categories: seeded ${Object.keys(CATEGORY_DATA).length} categories`);
}

// ─── States + sublocations (from NigerianStatesSeeder.php) ────────────────
const STATE_DATA: Record<string, { code: string; sublocations: string[] }> = {
  Lagos: { code: "LA", sublocations: ["Ikeja", "Lekki", "Yaba", "Victoria Island", "Ikoyi", "Surulere", "Ajah", "Festac", "Oshodi", "Mushin", "Apapa", "Maryland", "Gbagada", "Ikorodu", "Agege", "Ojodu", "Ogba", "Magodo", "Berger", "Ogudu", "Epe", "Badagry", "Alimosho", "Isolo"] },
  Abuja: { code: "FC", sublocations: ["Wuse", "Garki", "Maitama", "Asokoro", "Gwarinpa", "Jabi", "Kubwa", "Lugbe", "Nyanya", "Karu", "Utako", "Life Camp", "Wuye", "Gudu", "Durumi"] },
  Rivers: { code: "RI", sublocations: ["Port Harcourt", "Obio-Akpor", "Eleme", "Oyigbo", "Bonny", "Degema", "Ahoada", "Okrika"] },
  Kano: { code: "KN", sublocations: ["Nassarawa", "Fagge", "Sabon Gari", "Gwale", "Dala", "Tarauni", "Kumbotso", "Ungogo"] },
  Oyo: { code: "OY", sublocations: ["Ibadan North", "Ibadan South", "Bodija", "Mokola", "Challenge", "Ring Road", "Ojoo", "Agodi", "UI"] },
  Anambra: { code: "AN", sublocations: ["Awka", "Onitsha", "Nnewi", "Ekwulobia", "Obosi"] },
  Delta: { code: "DE", sublocations: ["Warri", "Asaba", "Sapele", "Ughelli", "Agbor", "Effurun"] },
  Enugu: { code: "EN", sublocations: ["Enugu", "Nsukka", "Agbani", "Udi", "Oji River"] },
  Kaduna: { code: "KD", sublocations: ["Kaduna North", "Kaduna South", "Zaria", "Kafanchan", "Kagoro"] },
  Edo: { code: "ED", sublocations: ["Benin City", "Auchi", "Ekpoma", "Uromi", "Irrua"] },
  Imo: { code: "IM", sublocations: ["Owerri", "Orlu", "Okigwe", "Oguta"] },
  Ogun: { code: "OG", sublocations: ["Abeokuta", "Sagamu", "Ijebu-Ode", "Ota", "Ilaro"] },
  Osun: { code: "OS", sublocations: ["Osogbo", "Ile-Ife", "Ilesa", "Ede", "Iwo"] },
  Ondo: { code: "ON", sublocations: ["Akure", "Ondo Town", "Owo", "Ikare"] },
  Kwara: { code: "KW", sublocations: ["Ilorin", "Offa", "Jebba", "Lafiagi"] },
  Abia: { code: "AB", sublocations: ["Aba", "Umuahia", "Ohafia"] },
  Benue: { code: "BE", sublocations: ["Makurdi", "Gboko", "Otukpo", "Katsina-Ala"] },
  "Cross River": { code: "CR", sublocations: ["Calabar", "Ogoja", "Ikom"] },
  "Akwa Ibom": { code: "AK", sublocations: ["Uyo", "Eket", "Ikot Ekpene", "Oron"] },
  Plateau: { code: "PL", sublocations: ["Jos", "Bukuru", "Barkin Ladi", "Pankshin"] },
  Niger: { code: "NI", sublocations: ["Minna", "Suleja", "Bida", "Kontagora"] },
  Bauchi: { code: "BA", sublocations: ["Bauchi", "Azare", "Misau"] },
  Borno: { code: "BO", sublocations: ["Maiduguri", "Biu", "Damboa"] },
  Gombe: { code: "GO", sublocations: ["Gombe", "Kumo", "Billiri"] },
  Adamawa: { code: "AD", sublocations: ["Yola", "Jimeta", "Mubi", "Numan"] },
  Taraba: { code: "TA", sublocations: ["Jalingo", "Wukari", "Takum"] },
  Nasarawa: { code: "NA", sublocations: ["Lafia", "Keffi", "Akwanga", "Nasarawa"] },
  Kogi: { code: "KO", sublocations: ["Lokoja", "Okene", "Kabba", "Idah"] },
  Ekiti: { code: "EK", sublocations: ["Ado-Ekiti", "Ikere", "Ikole", "Efon-Alaaye"] },
  Ebonyi: { code: "EB", sublocations: ["Abakaliki", "Afikpo", "Onueke"] },
  Bayelsa: { code: "BY", sublocations: ["Yenagoa", "Brass", "Sagbama"] },
  Zamfara: { code: "ZA", sublocations: ["Gusau", "Kaura Namoda", "Talata Mafara"] },
  Sokoto: { code: "SO", sublocations: ["Sokoto", "Tambuwal", "Wurno"] },
  Kebbi: { code: "KE", sublocations: ["Birnin Kebbi", "Argungu", "Yauri"] },
  Katsina: { code: "KT", sublocations: ["Katsina", "Daura", "Funtua"] },
  Jigawa: { code: "JI", sublocations: ["Dutse", "Hadejia", "Gumel"] },
  Yobe: { code: "YO", sublocations: ["Damaturu", "Potiskum", "Gashua"] },
};

async function seedStates() {
  for (const [name, data] of Object.entries(STATE_DATA)) {
    await db
      .insert(states)
      .values({ name, slug: slugify(name), code: data.code, isActive: true })
      .onConflictDoUpdate({ target: states.slug, set: { name, code: data.code, isActive: true } });
  }
  // Sublocations
  for (const [name, data] of Object.entries(STATE_DATA)) {
    const [st] = await db.select().from(states).where(eq(states.slug, slugify(name))).limit(1);
    if (!st) continue;
    for (const sub of data.sublocations) {
      await db
        .insert(sublocations)
        .values({ stateId: st.id, name: sub, slug: slugify(sub), isActive: true })
        .onConflictDoNothing({ target: [sublocations.stateId, sublocations.slug] });
    }
  }
  console.log(`states: seeded ${Object.keys(STATE_DATA).length} states + sublocations`);
}

// ─── Markets (imported from ../DistressNowApi/database/seeders/MarketSeeder.php via PHP) ─
function parseMarketSeeder(): { name: string; slug: string; state: string; sublocation: string; address: string; lat: null | number; lng: null | number }[] {
  const assetPath = join(__dirname, "data", "markets.json");
  try {
    return JSON.parse(readFileSync(assetPath, "utf8")) as {
      name: string;
      slug: string;
      state: string;
      sublocation: string;
      address: string;
      lat: null | number;
      lng: null | number;
    }[];
  } catch {
    console.warn("markets.json not found — skipping 2600+ markets.");
    return [];
  }
}

const FCT_ALIASES = new Set(["Federal Capital Territory", "FCT", "Abuja"]);

async function seedMarkets() {
  const rows = parseMarketSeeder();
  if (!rows.length) return;
  const allStates = await db.select().from(states);
  const bySlug = new Map(allStates.map((s) => [s.slug, s]));
  const byName = new Map(allStates.map((s) => [s.name, s]));
  const resolveState = (name: string) => {
    if (FCT_ALIASES.has(name) && !bySlug.has("federal-capital-territory")) return bySlug.get("abuja") ?? byName.get("Abuja");
    return bySlug.get(slugify(name)) ?? byName.get(name);
  };
  let inserted = 0;
  let failed = 0;
  for (const m of rows) {
    const st = resolveState(m.state);
    if (!st) {
      failed++;
      continue;
    }
    // Upsert sublocation if it doesn't exist yet (MarketSeeder does the same)
    let sub: { id: number } | undefined;
    if (m.sublocation) {
      const [existing] = await db
        .select({ id: sublocations.id })
        .from(sublocations)
        .where(and(eq(sublocations.stateId, st.id), eq(sublocations.slug, slugify(m.sublocation))))
        .limit(1);
      if (existing) sub = existing;
      else {
        const [created] = await db
          .insert(sublocations)
          .values({ stateId: st.id, name: m.sublocation, slug: slugify(m.sublocation), isActive: true })
          .onConflictDoNothing({ target: [sublocations.stateId, sublocations.slug] })
          .returning({ id: sublocations.id });
        if (created) sub = created;
      }
    }
    await db
      .insert(markets)
      .values({
        stateId: st.id,
        sublocationId: sub?.id ?? null,
        name: m.name,
        slug: m.slug,
        address: m.address ?? null,
        latitude: m.lat != null ? String(m.lat) : null,
        longitude: m.lng != null ? String(m.lng) : null,
        isActive: true,
      })
      .onConflictDoNothing({ target: [markets.stateId, markets.slug] });
    inserted++;
  }
  console.log(`markets: seeded ${inserted} (${failed} skipped, state unresolved)`);
}

// ─── Staff users (from StaffUsersSeeder.php, password 18781875) ───────────
const STAFF_USERS: { name: string; email: string; role: string }[] = [
  { name: "DistressNow Admin", email: "distressnow09@gmail.com", role: "admin" },
  { name: "DistressNow Admin Alias", email: "distressadmin@gmail.com", role: "admin" },
  { name: "DistressNow Verifier", email: "verifier@yopmail.com", role: "verifier" },
  { name: "DistressNow Shop Manager", email: "shop-manager@yopmail.com", role: "shop_manager" },
  { name: "DistressNow Shop Manager Alias", email: "shopmanager@yopmail.com", role: "shop_manager" },
];

async function seedStaff() {
  const password = await Bun.password.hash("18781875", { algorithm: "bcrypt", cost: 12 });
  for (const s of STAFF_USERS) {
    const [user] = await db
      .insert(users)
      .values({
        name: s.name,
        email: s.email,
        password,
        authProvider: "email",
        onboardingCompleted: true,
        emailVerifiedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: users.email,
        set: { name: s.name, onboardingCompleted: true },
      })
      .returning({ id: users.id });
    // Assign buyer + staff role (Laravel: assignRoleSafely('buyer') + staff role)
    for (const roleName of ["buyer", s.role]) {
      const [role] = await db.select().from(roles).where(eq(roles.name, roleName)).limit(1);
      if (role && user) {
        await db
          .insert(modelHasRoles)
          .values({ roleId: role.id, modelType: "App\\Models\\User", modelId: user.id })
          .onConflictDoNothing();
      }
    }
  }
  console.log(`staff users: seeded ${STAFF_USERS.length} (password: 18781875)`);
}

async function main() {
  await seedRoles();
  await seedCategories();
  await seedStates();
  await seedMarkets();
  await seedStaff();
  const counts = {
    roles: (await db.select().from(roles)).length,
    categories: (await db.select().from(categories)).length,
    subcategories: (await db.select().from(subcategories)).length,
    states: (await db.select().from(states)).length,
    sublocations: (await db.select().from(sublocations).orderBy(desc(sublocations.id))).length,
    markets: (await db.select().from(markets).orderBy(desc(markets.id))).length,
    users: (await db.select().from(users)).length,
  };
  console.log("Final counts:", JSON.stringify(counts));
  // Close the postgres-js pool when executed directly.
  const sql = (db as unknown as { $client?: { end?: () => Promise<void> } }).$client;
  await sql?.end?.();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});