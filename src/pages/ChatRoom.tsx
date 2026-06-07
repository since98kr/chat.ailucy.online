import React, { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'ai';
  timestamp: Date;
  isEdited?: boolean;
}

const ChatRoom: React.FC = () => {
  const { roomId } = useParams<{ roomId: string }>();
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      text: `Welcome to the ${roomId} chat room! How can I help you today?`,
      sender: 'ai',
      timestamp: new Date(),
    },
  ]);
  const [inputValue, setInputValue] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim()) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      text: inputValue,
      sender: 'user',
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputValue('');

    // Simulate AI response
    setTimeout(() => {
      const aiResponse: Message = {
        id: (Date.now() + 1).toString(),
        text: `I received your message: "${inputValue}". This is a simulated response for the ${roomId} room using Material 3 design principles.`,
        sender: 'ai',
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, aiResponse]);
    }, 1000);
  };

  const handleDeleteMessage = (id: string) => {
    setMessages((prev) => prev.filter((msg) => msg.id !== id));
  };

  const handleStartEdit = (msg: Message) => {
    setEditingId(msg.id);
    setEditValue(msg.text);
  };

  const handleUpdateMessage = (id: string) => {
    if (!editValue.trim()) return;
    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === id ? { ...msg, text: editValue, isEdited: true } : msg
      )
    );
    setEditingId(null);
    setEditValue('');
  };

  const getThemeColors = () => {
    switch (roomId) {
      case 'openclaw':
        return {
          primary: 'bg-emerald-700',
          container: 'bg-emerald-50',
          onContainer: 'text-emerald-900',
          bubble: 'bg-emerald-100',
          text: 'text-emerald-950',
          button: 'bg-emerald-700 hover:bg-emerald-800',
          header: 'bg-emerald-50 text-emerald-900'
        };
      case 'hermes':
        return {
          primary: 'bg-violet-700',
          container: 'bg-violet-50',
          onContainer: 'text-violet-900',
          bubble: 'bg-violet-100',
          text: 'text-violet-950',
          button: 'bg-violet-700 hover:bg-violet-800',
          header: 'bg-violet-50 text-violet-900'
        };
      default:
        return {
          primary: 'bg-blue-700',
          container: 'bg-blue-50',
          onContainer: 'text-blue-900',
          bubble: 'bg-blue-100',
          text: 'text-blue-950',
          button: 'bg-blue-700 hover:bg-blue-800',
          header: 'bg-blue-50 text-blue-900'
        };
    }
  };

  const theme = getThemeColors();

  return (
    <div className={`min-h-screen ${theme.container} flex flex-col font-sans`}>
      {/* M3 Tonal App Bar */}
      <header className={`${theme.header} px-4 py-3 flex items-center sticky top-0 z-10 shadow-sm transition-colors duration-300`}>
        <Link to="/" className={`p-2 rounded-full hover:bg-black/5 transition-colors mr-2`}>
          <svg viewBox="0 0 24 24" className="w-6 h-6 fill-current">
            <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
          </svg>
        </Link>
        <h1 className="text-xl font-semibold capitalize tracking-tight">{roomId}</h1>
        <div className="flex-grow"></div>
        <button className="p-2 rounded-full hover:bg-black/5">
          <svg viewBox="0 0 24 24" className="w-6 h-6 fill-current">
            <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
          </svg>
        </button>
      </header>

      <main className="flex-grow flex flex-col p-4 max-w-5xl mx-auto w-full overflow-hidden">
        {/* Messages Container with M3 rounded corners */}
        <div className="flex-grow overflow-y-auto space-y-2 mb-4 px-2 custom-scrollbar">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex w-full ${msg.sender === 'user' ? 'justify-end' : 'justify-start'} animate-in fade-in slide-in-from-bottom-2 duration-300 group`}
            >
              <div className={`flex flex-col max-w-[85%] sm:max-w-[70%]`}>
                <div
                  className={`px-4 py-3 shadow-sm ${
                    msg.sender === 'user'
                      ? `${theme.primary} text-white rounded-[20px] rounded-tr-[4px]`
                      : `${theme.bubble} ${theme.text} rounded-[20px] rounded-tl-[4px]`
                  }`}
                >
                  {editingId === msg.id ? (
                    <div className="flex flex-col gap-2 min-w-[200px]">
                      <textarea
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        className="bg-white/20 border border-white/30 rounded-lg p-2 text-white focus:outline-none focus:ring-2 focus:ring-white/50 resize-none"
                        rows={3}
                        autoFocus
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => setEditingId(null)}
                          className="px-3 py-1 text-xs font-medium rounded-full hover:bg-white/10 transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => handleUpdateMessage(msg.id)}
                          className="px-3 py-1 text-xs font-medium bg-white text-emerald-900 rounded-full hover:bg-white/90 transition-colors"
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="leading-relaxed text-[15px] whitespace-pre-wrap">{msg.text}</p>
                  )}
                </div>
                <div className={`mt-1 flex items-center gap-2 ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.sender === 'user' && !editingId && (
                    <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => handleStartEdit(msg)}
                        className="p-1.5 rounded-full hover:bg-black/5 text-gray-500"
                        title="Edit"
                      >
                        <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 fill-current">
                          <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => handleDeleteMessage(msg.id)}
                        className="p-1.5 rounded-full hover:bg-red-50 text-gray-500 hover:text-red-600"
                        title="Delete"
                      >
                        <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 fill-current">
                          <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
                        </svg>
                      </button>
                    </div>
                  )}
                  <span className="text-[11px] font-medium opacity-60 px-1 whitespace-nowrap">
                    {msg.isEdited && <span className="mr-1 italic">(edited)</span>}
                    {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area - M3 style */}
        <div className="pt-2 px-2">
          <form onSubmit={handleSendMessage} className="flex items-center gap-3 bg-white/60 backdrop-blur-md p-2 pl-5 rounded-full border border-black/5 shadow-md">
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="Message..."
              className="flex-grow bg-transparent border-none focus:outline-none py-2 text-gray-800 placeholder-gray-500"
            />
            <button
              type="submit"
              disabled={!inputValue.trim()}
              className={`${theme.button} text-white w-12 h-12 flex items-center justify-center rounded-full transition-all duration-200 shadow-sm disabled:opacity-50 disabled:grayscale`}
            >
              <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            </button>
          </form>
        </div>
      </main>

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(0, 0, 0, 0.1);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(0, 0, 0, 0.2);
        }
      `}} />
    </div>
  );
};

export default ChatRoom;
