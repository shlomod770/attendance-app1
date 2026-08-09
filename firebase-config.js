// ============================================================
// כאן צריך להדביק את הפרטים מהפרויקט שלכם ב-Firebase.
// ראו את ההוראות שקיבלתם כדי לדעת איך משיגים את זה (זה בחינם).
// ============================================================
const firebaseConfig = {
  apiKey: "PASTE_API_KEY_HERE",
  authDomain: "PASTE_PROJECT_ID.firebaseapp.com",
  projectId: "PASTE_PROJECT_ID",
  storageBucket: "PASTE_PROJECT_ID.appspot.com",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
