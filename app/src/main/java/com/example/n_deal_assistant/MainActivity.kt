package com.example.n_deal_assistant

import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.unit.dp
import com.google.firebase.Timestamp
import com.google.firebase.firestore.*
import kotlinx.coroutines.launch
import java.io.InputStream
import java.util.*

// =========================
// DATA
// =========================

data class Message(
    val id: String = "",
    val text: String = "",
    val role: String = "",
    val type: String = "",
    val deal: Map<String, Any>? = null,
    val createdAt: Timestamp? = null
)

// =========================
// ACTIVITY
// =========================

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { AppScreen() }
    }
}

// =========================
// NAVIGATION
// =========================

@Composable
fun AppScreen() {
    var screen by remember { mutableStateOf("home") }

    Scaffold(
        topBar = {
            Row(
                modifier = Modifier.fillMaxWidth().padding(8.dp),
                horizontalArrangement = Arrangement.SpaceEvenly
            ) {
                TabButton("Home", screen == "home") { screen = "home" }
                TabButton("New", screen == "chat") { screen = "chat" }
                TabButton("Deals", screen == "deals") { screen = "deals" }
            }
        }
    ) { padding ->
        Box(modifier = Modifier.padding(padding)) {
            when (screen) {
                "home" -> HomeScreen(
                    onChatClick = { screen = "chat" },
                    onDealsClick = { screen = "deals" }
                )
                "chat" -> ChatScreen(
                    onOpenDeals = { screen = "deals" }
                )
                "deals" -> DealsScreen()
            }
        }
    }
}

// =========================
// TAB BUTTON
// =========================

@Composable
fun TabButton(title: String, isActive: Boolean, onClick: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        TextButton(onClick = onClick) {
            Text(
                title,
                fontWeight = if (isActive) FontWeight.Bold else FontWeight.Normal,
                color = if (isActive)
                    MaterialTheme.colorScheme.primary
                else
                    MaterialTheme.colorScheme.onSurface
            )
        }

        if (isActive) {
            Box(
                modifier = Modifier
                    .height(2.dp)
                    .width(40.dp)
                    .background(MaterialTheme.colorScheme.primary)
            )
        } else {
            Spacer(modifier = Modifier.height(2.dp))
        }
    }
}

// =========================
// HOME
// =========================

@Composable
fun HomeScreen(onChatClick: () -> Unit, onDealsClick: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text("Welcome to Deal Assistant")

        Spacer(modifier = Modifier.height(24.dp))

        Button(onClick = onChatClick, modifier = Modifier.fillMaxWidth()) {
            Text("Start new deal")
        }

        Spacer(modifier = Modifier.height(12.dp))

        Button(onClick = onDealsClick, modifier = Modifier.fillMaxWidth()) {
            Text("View deals")
        }
    }
}

// =========================
// CHAT
// =========================

@Composable
fun ChatScreen(onOpenDeals: () -> Unit) {

    var text by remember { mutableStateOf("") }
    var messages by remember { mutableStateOf(listOf<Message>()) }
    var showPostActions by remember { mutableStateOf(false) }

    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    val context = LocalContext.current
    val prefs = context.getSharedPreferences("app_prefs", Context.MODE_PRIVATE)

    val userId = remember {
        val existing = prefs.getString("userId", null)
        if (existing != null) existing
        else {
            val newId = UUID.randomUUID().toString()
            prefs.edit().putString("userId", newId).apply()
            newId
        }
    }

    val sessionId = remember { UUID.randomUUID().toString() }
    val db = FirebaseFirestore.getInstance()

    val imageLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent()
    ) { uri ->
        if (uri != null) {

            val fileName = uri.lastPathSegment ?: "file"

            // Show toast/snackbar
            scope.launch {
                snackbarHostState.showSnackbar("Reading your file...")
            }

            val base64 = uriToBase64(context, uri) ?: return@rememberLauncherForActivityResult

            // Single message: visible + processing
            db.collection("users")
                .document(userId)
                .collection("messages")
                .add(
                    mapOf(
                        "text" to "$fileName file attached",
                        "imageBase64" to base64,
                        "role" to "user",
                        "sessionId" to sessionId,
                        "createdAt" to FieldValue.serverTimestamp()
                    )
                )
        }
    }

    DisposableEffect(Unit) {
        val listener = db.collection("users")
            .document(userId)
            .collection("messages")
            .whereEqualTo("sessionId", sessionId)
            .addSnapshotListener { snapshots, _ ->
                if (snapshots != null) {
                    val list = snapshots.documents.map {
                        val type = it.getString("type") ?: ""

                        if (type == "status") {
                            showPostActions = true
                        }

                        Message(
                            id = it.id,
                            text = it.getString("text") ?: "",
                            role = it.getString("role") ?: "",
                            type = type,
                            deal = it.get("deal") as? Map<String, Any>,
                            createdAt = it.getTimestamp("createdAt")
                        )
                    }.sortedBy { it.createdAt?.seconds ?: 0 }

                    messages = list
                }
            }
        onDispose { listener.remove() }
    }

    fun send(textValue: String) {
        db.collection("users")
            .document(userId)
            .collection("messages")
            .add(
                mapOf(
                    "text" to textValue,
                    "role" to "user",
                    "sessionId" to sessionId,
                    "createdAt" to FieldValue.serverTimestamp()
                )
            )
    }

    fun saveDeal() {
        db.collection("users")
            .document(userId)
            .collection("messages")
            .add(
                mapOf(
                    "action" to "save",
                    "role" to "user",
                    "sessionId" to sessionId,
                    "createdAt" to FieldValue.serverTimestamp()
                )
            )
    }

    Scaffold(snackbarHost = { SnackbarHost(snackbarHostState) }) { padding ->

        Column(
            modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp)
        ) {

            Text(
                "Create a new deal.\n\n" +
                        "Provide:\n• Location\n• Size\n• Purchase price\n\n" +
                        "Or paste a listing link or upload a screenshot."
            )

            Spacer(modifier = Modifier.height(16.dp))

            LazyColumn(modifier = Modifier.weight(1f)) {
                items(messages) { msg ->
                    MessageItem(msg, onSave = { saveDeal() })
                }
            }

            if (showPostActions) {

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceEvenly
                ) {

                    Button(onClick = {
                        messages = emptyList()
                        showPostActions = false
                    }) {
                        Text("New deal")
                    }

                    Button(onClick = {
                        onOpenDeals()
                    }) {
                        Text("Open deals")
                    }
                }

                Spacer(modifier = Modifier.height(8.dp))
            }

            Row(verticalAlignment = Alignment.CenterVertically) {

                IconButton(onClick = { imageLauncher.launch("image/*") }) {
                    Icon(
                        imageVector = Icons.Default.AttachFile,
                        contentDescription = "Attach file"
                    )
                }

                TextField(
                    value = text,
                    onValueChange = { text = it },
                    modifier = Modifier.weight(1f)
                )

                Button(
                    onClick = {
                        if (text.isNotBlank()) {
                            send(text)
                            text = ""
                        }
                    }
                ) {
                    Text("Send")
                }
            }
        }
    }
}

// =========================
// MESSAGE ITEM
// =========================

@Composable
fun MessageItem(message: Message, onSave: () -> Unit) {

    when {
        message.type == "preview" && message.deal != null -> {
            PreviewCard(message.deal, onSave)
        }

        else -> {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = if (message.role == "user") Arrangement.End else Arrangement.Start
            ) {
                Card(modifier = Modifier.padding(4.dp)) {
                    val isAttachment = message.text.contains("file attached", ignoreCase = true)
                    Text(
                        message.text,
                        modifier = Modifier.padding(12.dp),
                        fontStyle = if (isAttachment) FontStyle.Italic else FontStyle.Normal
                    )
                }
            }
        }
    }
}

// =========================
// PREVIEW CARD
// =========================

@Composable
fun PreviewCard(deal: Map<String, Any>, onSave: () -> Unit) {

    val location = deal["location"]?.toString() ?: "-"
    val size = (deal["size"] as? Number)?.toInt() ?: 0
    val price = (deal["purchasePrice"] as? Number)?.toInt() ?: 0

    val gdv = (deal["gdv"] as? Number)?.toInt() ?: 0
    val cost = (deal["cost"] as? Number)?.toInt() ?: 0
    val profit = (deal["profit"] as? Number)?.toInt() ?: 0

    val roi = (deal["roi"] as? Number)?.toInt() ?: 0
    val margin = (deal["margin"] as? Number)?.toInt() ?: 0

    Card(
        modifier = Modifier.fillMaxWidth().padding(8.dp)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {

            Text("Deal Preview", fontWeight = FontWeight.Bold)

            Spacer(modifier = Modifier.height(8.dp))

            Text("Location: $location")
            Text("Size: $size sqm")
            Text("Price: €$price")

            Spacer(modifier = Modifier.height(8.dp))

            Text("GDV: €$gdv")
            Text("Cost: €$cost")
            Text("Profit: €$profit")

            Spacer(modifier = Modifier.height(8.dp))

            Text("ROI: $roi%")
            Text("Margin: $margin%")

            Spacer(modifier = Modifier.height(12.dp))

            Button(
                onClick = onSave,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("Save deal")
            }
        }
    }
}

// =========================
// DEALS (FIXED)
// =========================

@Composable
fun DealsScreen() {

    var deals by remember { mutableStateOf(listOf<DocumentSnapshot>()) }
    var expandedIndex by remember { mutableStateOf<Int?>(null) }

    val context = LocalContext.current
    val prefs = context.getSharedPreferences("app_prefs", Context.MODE_PRIVATE)
    val userId = prefs.getString("userId", "") ?: ""

    val db = FirebaseFirestore.getInstance()

    DisposableEffect(Unit) {
        val listener = db.collection("users")
            .document(userId)
            .collection("deals")
            .orderBy("createdAt", Query.Direction.DESCENDING)
            .addSnapshotListener { snapshots, _ ->
                if (snapshots != null) deals = snapshots.documents
            }
        onDispose { listener.remove() }
    }

    LazyColumn(modifier = Modifier.padding(16.dp)) {

        itemsIndexed(deals, key = { _, doc -> doc.id }) { index, doc ->

            val deal = doc.data ?: emptyMap<String, Any>()
            val isExpanded = expandedIndex == index
            var menuExpanded by remember { mutableStateOf(false) }

            val location = deal["location"]?.toString() ?: "-"
            val size = (deal["size"] as? Number)?.toDouble() ?: 0.0
            val price = (deal["purchasePrice"] as? Number)?.toDouble() ?: 0.0

            val gdv = size * 2500
            val cost = size * 1000
            val total = cost + price
            val profit = gdv - total
            val roi = if (total != 0.0) ((profit / total) * 100).toInt() else 0
            val margin = if (gdv != 0.0) ((profit / gdv) * 100).toInt() else 0

            val name = "$location Deal"

            Card(
                modifier = Modifier.fillMaxWidth().padding(6.dp),
                onClick = {
                    expandedIndex = if (isExpanded) null else index
                }
            ) {

                Column(
                    modifier = Modifier.padding(12.dp).animateContentSize()
                ) {

                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {

                        Text(name, style = MaterialTheme.typography.titleMedium)

                        Box {
                            IconButton(onClick = { menuExpanded = true }) {
                                Icon(Icons.Default.MoreVert, contentDescription = null)
                            }

                            DropdownMenu(
                                expanded = menuExpanded,
                                onDismissRequest = { menuExpanded = false }
                            ) {

                                DropdownMenuItem(
                                    text = { Text("Report") },
                                    onClick = { },
                                    enabled = false
                                )

                                DropdownMenuItem(
                                    text = { Text("Edit") },
                                    onClick = { },
                                    enabled = false
                                )

                                DropdownMenuItem(
                                    text = { Text("Delete") },
                                    onClick = {
                                        menuExpanded = false
                                        db.collection("users")
                                            .document(userId)
                                            .collection("deals")
                                            .document(doc.id)
                                            .delete()
                                    }
                                )
                            }
                        }
                    }

                    Spacer(modifier = Modifier.height(6.dp))

                    if (!isExpanded) {

                        Text("Location: $location")
                        Text("ROI: $roi% | Margin: $margin%")

                    } else {

                        Spacer(modifier = Modifier.height(8.dp))

                        Text("Location: $location")
                        Text("Size: ${size.toInt()} sqm")
                        Text("Price: €${price.toInt()}")

                        Spacer(modifier = Modifier.height(8.dp))

                        Text("GDV: €${gdv.toInt()}")
                        Text("Cost: €${cost.toInt()}")
                        Text("Profit: €${profit.toInt()}")

                        Spacer(modifier = Modifier.height(8.dp))

                        Text("ROI: $roi%")
                        Text("Margin: $margin%")
                    }
                }
            }
        }
    }
}

// =========================
// BASE64
// =========================

fun uriToBase64(context: Context, uri: Uri): String? {
    return try {
        val inputStream: InputStream? = context.contentResolver.openInputStream(uri)
        val bytes = inputStream?.readBytes()
        inputStream?.close()
        bytes?.let { Base64.encodeToString(it, Base64.NO_WRAP) }
    } catch (e: Exception) {
        null
    }
}