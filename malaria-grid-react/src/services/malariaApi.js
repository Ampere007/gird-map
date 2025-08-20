// src/services/malariaApi.js
const API = 'https://malaria-api.ddc-malaria.org';

// รายชื่อจังหวัด (ใช้เติม dropdown)
export async function listProvinces() {
  const res = await fetch(`${API}/ms/getListProvince`);
  if (!res.ok) throw new Error('getListProvince failed');
  return res.json();
}

// **สำคัญ**: ให้แทนที่ฟังก์ชันนี้ด้วย endpoint รายหมู่บ้านจริงจาก Network ของคุณ
// ให้คืนรูปแบบ [{ code, nameTH, lat, lng }]
export async function listVillagesByProvince(provinceCode) {
  // ตัวอย่างโครงสร้าง—กรุณาเปลี่ยน URL ให้ตรงกับที่คุณเจอใน DevTools
  const url = `${API}/ms/getListVillageByProvince/${provinceCode}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('listVillagesByProvince failed');
  const json = await res.json();
  // map เป็นรูปแบบที่ใช้สะดวก
  return json.data.map(v => ({
    code: v.villageCode,
    nameTH: v.villageNameTH,
    lat: +v.lat,
    lng: +v.lng,
  }));
}

// ยอดเคสของ "หมู่บ้าน" หนึ่ง ๆ ในช่วงวัน
export async function getVillageTotal(villageCode, startYYYYMMDD, endYYYYMMDD) {
  const url = `${API}/groupage/getListGroupAgeTotal/village/${villageCode}/${startYYYYMMDD}/${endYYYYMMDD}/1,2,3,4,5/F,K,M,Mix,O,V/01,02,03,04/A,Bx,By,Bz,Bo,Bf,F,C,D,E,G,NA/odpc`;
  const res = await fetch(url);
  if (!res.ok) return 0;
  const json = await res.json();
  // ปรับการอ่าน field ให้ตรง response จริง (ด้านล่างเป็นตัวอย่างทั่วไป)
  const rows = json?.data ?? [];
  const total = rows.reduce((s, r) => s + (r.total ?? 0), 0);
  return total;
}
