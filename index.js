const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Bot muvaffaqiyatli ishlamoqda!');
});

app.listen(PORT, () => {
    console.log(`Soxta veb-server ${PORT}-portda ishga tushdi.`);
});


const TelegramBot = require('node-telegram-bot-api');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const NEON_CONNECTION_STRING = 'postgresql://neondb_owner:npg_UzbycfQ4M7tg@ep-bitter-meadow-app9f5r3.c-7.us-east-1.aws.neon.tech/neondb?sslmode=require'; // Neon panelidan olingan ulanish kodigit init


// --- SOZLAMALAR ---
const token = '8905749647:AAEnnXevqVShjmXGJwxkSnkASYK0_jA_QM0'; // BotFather'dan olingan token
const SUPER_ADMIN_ID = 5022826584;        // O'zingizning Telegram ID raqamingiz
const TARGET_CHAT_ID = -1003995579963;  // Test yuboriladigan doimiy guruh yoki kanal ID-si

const pool = new Pool({
    connectionString: NEON_CONNECTION_STRING,
    ssl: { rejectUnauthorized: false }
});

const bot = new TelegramBot(token, { polling: true });

// Global xotira (Yuklangan testlar uchun)
let activeQuizzes = []; 
let adminState = {}; 

// --- BAZA BILAN ISHLASH FUNKSIYALARI ---

// Adminlik huquqini tekshirish
async function isAdmin(chatId) {
    if (chatId === SUPER_ADMIN_ID) return true;
    try {
        const res = await pool.query('SELECT * FROM admins WHERE telegram_id = \$1', [chatId]);
        return res.rows.length > 0;
    } catch (err) {
        console.error("Bazada adminni tekshirishda xato:", err);
        return false;
    }
}

// --- KLAVIATURA (MENU) ---
const adminKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: "📊 Natijalarni tahlil qilish" }, { text: "🧹 Ma'lumotlarni tozalash" }],
            [{ text: "📢 Testni guruh/kanalga yuborish" }],
            [{ text: "➕ Admin Qo'shish" }, { text: "➖ Admin O'chirish" }, { text: "👥 Adminlar Ro'yxati" }]
        ],
        resize_keyboard: true
    }
};

console.log("🚀 Bot Neon.tech bulutli bazasi bilan muvaffaqiyatli ishga tushdi...");

// /start buyrug'i
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const isUserAdmin = await isAdmin(chatId);
    
    if (isUserAdmin) {
        bot.sendMessage(chatId, "👋 Salom Admin! Panelga xush kelibsiz.\nTest yuklash uchun menga Excel (.xlsx) fayl yuboring.", adminKeyboard);
    } else {
        bot.sendMessage(chatId, "👋 Salom! Bu test tizimi boti. Admin guruh yoki kanalga test yuborganida ishtirok etishingiz mumkin.");
    }
});

// Excel faylni qabul qilish
bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    const isUserAdmin = await isAdmin(chatId);

    if (!isUserAdmin) return;

    if (msg.document.file_name.endsWith('.xlsx')) {
        bot.sendMessage(chatId, "⏳ Excel fayl yuklab olinmoqda va tahlil qilinmoqda...");

        try {
            const downloadDir = __dirname;
            const rawFilePath = await bot.downloadFile(msg.document.file_id, downloadDir);
            
            const correctedFilePath = path.join(downloadDir, "temp_" + Date.now() + ".xlsx");
            fs.renameSync(rawFilePath, correctedFilePath);
            
            const workbook = xlsx.readFile(correctedFilePath);
            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];
            
            const data = xlsx.utils.sheet_to_json(worksheet, { header: 1 });

            activeQuizzes = []; 

            for (let i = 0; i < data.length; i++) {
                const row = data[i];
                if (!row || row.length < 2) continue; 

                let question = String(row[0]).trim(); 
                let rawOptions = row.slice(1);       
                
                let cleanOptions = rawOptions.map(opt => opt !== undefined && opt !== null ? String(opt).trim() : "").filter(opt => opt !== "");
                
                if (cleanOptions.length < 2) continue; 

                let correctAnswerIndex = -1;

                let finalOptions = cleanOptions.map((opt, index) => {
                    if (opt.startsWith('*') || opt.endsWith('*')) {
                        correctAnswerIndex = index;
                        return opt.replace(/\*/g, '').trim();
                    }
                    return opt;
                });

                if (correctAnswerIndex !== -1) {
                    activeQuizzes.push({
                        question: question,
                        options: finalOptions,
                        correct_option_id: correctAnswerIndex
                    });
                }
            }

            if (fs.existsSync(correctedFilePath)) {
                fs.unlinkSync(correctedFilePath);
            }

            if (activeQuizzes.length === 0) {
                bot.sendMessage(chatId, "⚠️ Excel o'qildi, lekin mos keladigan savollar topilmadi!\n\nTekshiring:\n1. To'g'ri javob boshiga yoki oxiriga * belgisi qo'yilganmi? (Masalan: *Toshkent)\n2. Savollar eng birinchi listda joylashganmi?", adminKeyboard);
            } else {
                bot.sendMessage(chatId, "✅ Excel muvaffaqiyatli yuklandi!\n🎯 Topilgan jami savollar: " + activeQuizzes.length + " ta.\n\nEndi '📢 Testni guruh/kanalga yuborish' tugmasini bosishingiz mumkin.", adminKeyboard);
            }

        } catch (error) {
            bot.sendMessage(chatId, "❌ Excel faylni o'qishda jiddiy xatolik yuz berdi.");
            console.error(error);
        }
    } else {
        bot.sendMessage(chatId, "⚠️ Iltimos, faqat .xlsx formatidagi Excel fayl yuboring.");
    }
});

// Admin xabarlari va Tugmalar boshqaruvi
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const isUserAdmin = await isAdmin(chatId);

    if (!isUserAdmin) return;

    if (adminState[chatId]) {
        const state = adminState[chatId];
        delete adminState[chatId]; 

        if (state === 'WAITING_FOR_ADD_ADMIN') {
            const newAdminId = parseInt(text);
            if (!isNaN(newAdminId)) {
                if (newAdminId === SUPER_ADMIN_ID) {
                    return bot.sendMessage(chatId, "ℹ️ Bu foydalanuvchi Bosh Admin.", adminKeyboard);
                }
                
                try {
                    await pool.query('INSERT INTO admins (telegram_id) VALUES (\$1) ON CONFLICT DO NOTHING', [newAdminId]);
                    bot.sendMessage(chatId, "✅ Yangi admin Neon bazasiga qo'shildi! ID: " + newAdminId, adminKeyboard);
                    bot.sendMessage(newAdminId, "🎉 Siz ushbu botga admin qilib tayinlandingiz! Panelni ochish uchun /start bosing.");
                } catch (err) {
                    bot.sendMessage(chatId, "❌ Admin qo'shishda xatolik yuz berdi.", adminKeyboard);
                }
            } else {
                bot.sendMessage(chatId, "❌ Noto'g'ri ID. Faqat raqam yuboring.", adminKeyboard);
            }
            return;
        }

        if (state === 'WAITING_FOR_REMOVE_ADMIN') {
            const removeId = parseInt(text);
            if (removeId === SUPER_ADMIN_ID) {
                return bot.sendMessage(chatId, "❌ Bosh adminni o'chirib bo'lmaydi!", adminKeyboard);
            }
            
            try {
                await pool.query('DELETE FROM admins WHERE telegram_id = \$1', [removeId]);
                bot.sendMessage(chatId, "🗑 Admin bazadan o'chirildi! ID: " + removeId, adminKeyboard);
                bot.sendMessage(removeId, "🚫 Sizning adminlik huquqingiz bekor qilindi.");
            } catch (err) {
                bot.sendMessage(chatId, "❌ Adminni o'chirishda xatolik yuz berdi.", adminKeyboard);
            }
            return;
        }
    }

    // --- Standart Tugmalar buyruqlari ---
    if (text === "📊 Natijalarni tahlil qilish") {
        try {
            const res = await pool.query('SELECT * FROM results ORDER BY correct_count DESC');
            const results = res.rows;

            if (results.length === 0) {
                return bot.sendMessage(chatId, "📭 Hozircha bazada hech qanday natijalar mavjud emas.");
            }

            let report = "📋 Foydalanuvchilar natijalari (Neon Baza):\n\n";
            results.forEach((user, index) => {
                let calculatedScore = user.correct_count * 10;
                report += (index + 1) + ". 👤 " + user.name + " — 🎯 To'g'ri: " + user.correct_count + " ta — 🏆 Ball: " + calculatedScore + "\n";
            });
            bot.sendMessage(chatId, report);
        } catch (err) {
            bot.sendMessage(chatId, "❌ Natijalarni yuklashda xatolik.");
        }
    }

    else if (text === "🧹 Ma'lumotlarni tozalash") {
        try {
            await pool.query('TRUNCATE TABLE results');
            activeQuizzes = [];
            bot.sendMessage(chatId, "🗑 Bazadagi barcha natijalar va yuklangan testlar butunlay tozalandi.");
        } catch (err) {
            bot.sendMessage(chatId, "❌ Tozalashda xatolik yuz berdi.");
        }
    }

    else if (text === "📢 Testni guruh/kanalga yuborish") {
        if (activeQuizzes.length === 0) {
            return bot.sendMessage(chatId, "⚠️ Avval Excel fayl yuborib, testlarni yuklang!");
        }

        bot.sendMessage(chatId, "🚀 Testlar sozlangan guruh/kanalga yuborilmoqda...");

        let successCount = 0;
        for (const quiz of activeQuizzes) {
            try {
                await bot.sendPoll(TARGET_CHAT_ID, quiz.question, quiz.options, {
                    type: 'quiz',
                    correct_option_id: quiz.correct_option_id,
                    is_anonymous: false 
                });
                successCount++;
                await new Promise(resolve => setTimeout(resolve, 1500)); 
            } catch (err) {
                bot.sendMessage(chatId, "❌ Xatolik yuz berdi: " + err.message + "\nBot adminligini tekshiring.", adminKeyboard);
                return;
            }
        }
        bot.sendMessage(chatId, "✅ " + successCount + " ta test guruhga muvaffaqiyatli yuborildi!", adminKeyboard);
    }
    
    else if (text === "➕ Admin Qo'shish") {
        if (chatId !== SUPER_ADMIN_ID) return bot.sendMessage(chatId, "⚠️ Bu buyruq faqat Bosh Admin uchun.");
bot.sendMessage(chatId, "👤 Yangi adminning Telegram ID raqamini kiriting:", { reply_markup: { remove_keyboard: true } });
adminState[chatId] = 'WAITING_FOR_ADD_ADMIN';
}
else if (text === "➖ Admin O'chirish") {
if (chatId !== SUPER_ADMIN_ID) return bot.sendMessage(chatId, "⚠️ Bu buyruq faqat Bosh Admin uchun.");
bot.sendMessage(chatId, "🗑 O'chiriladigan adminning Telegram ID raqamini kiriting:", { reply_markup: { remove_keyboard: true } });
adminState[chatId] = 'WAITING_FOR_REMOVE_ADMIN';
}
else if (text === "👥 Adminlar Ro'yxati") {
bot.sendMessage(chatId, "⏳ Adminlar ma'lumotlari yuklanmoqda...");
try {
const res = await pool.query('SELECT * FROM admins');
const admins = res.rows;
let msgText = "👥 Bot adminlari ro'yxati (Neon Baza):\n\n";
try {
let superChat = await bot.getChat(SUPER_ADMIN_ID);
let superName = superChat.first_name + (superChat.username ? " (@" + superChat.username + ")" : "");
msgText += "1. " + superName + " 👑 (Bosh Admin)\n";
} catch (e) {
msgText += "1. ID: " + SUPER_ADMIN_ID + " 👑 (Bosh Admin)\n";
}
for (let i = 0; i < admins.length; i++) {
let admId = admins[i].telegram_id;
try {
let adminChat = await bot.getChat(admId);
let adminName = adminChat.first_name + (adminChat.username ? " (@" + adminChat.username + ")" : "");
msgText += (i + 2) + ". " + adminName + " 🛠 (Admin)\n";
} catch (error) {
msgText += (i + 2) + ". ID: " + admId + " 🛠 (Admin)\n";
}
}
bot.sendMessage(chatId, msgText);
} catch (err) {
bot.sendMessage(chatId, "❌ Adminlar ro'yxatini yuklashda xatolik.");
}
}
});
// Foydalanuvchilar javob berganda ma'lumotlarni bazaga yozish (Upsert mantiqi)
bot.on('poll_answer', async (answer) => {
const userId = answer.user.id;
const firstName = answer.user.first_name || "";
const username = answer.user.username ? " (@" + answer.user.username + ")" : "";
const fullName = firstName + username;
try {
await pool.query("INSERT INTO results (id, name, correct_count) VALUES ($1, $2, 1) ON CONFLICT (id) DO UPDATE SET name = $2, correct_count = results.correct_count + 1", [userId, fullName]);
} catch (err) {
console.error("Foydalanuvchi balini bazaga yozishda xato:", err);
}
});