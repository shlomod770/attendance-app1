// ============================================================
// כאן צריך להדביק את הפרטים מהפרויקט שלכם ב-Firebase.
// ראו את ההוראות שקיבלתם כדי לדעת איך משיגים את זה (זה בחינם).
// ============================================================
// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyCurmPXzbz5lqW6VvxTWosY4RPzEUim_po",
  authDomain: "attendance-8e594.firebaseapp.com",
  projectId: "attendance-8e594",
  storageBucket: "attendance-8e594.firebasestorage.app",
  messagingSenderId: "130707494835",
  appId: "1:130707494835:web:a7b733cafafefcefd19dc6"
};


firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
