import React from 'react';
import { useParams, Link } from 'react-router-dom';

const ChatRoom: React.FC = () => {
  const { roomId } = useParams<{ roomId: string }>();

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-white shadow-sm p-4 flex justify-between items-center">
        <Link to="/" className="text-blue-600 hover:text-blue-800 font-medium flex items-center">
          <span className="mr-2">←</span> Back to Rooms
        </Link>
        <h1 className="text-xl font-bold text-gray-800 capitalize">Room: {roomId}</h1>
        <div className="w-24"></div> {/* Spacer */}
      </header>

      <main className="flex-grow p-4 flex flex-col items-center justify-center">
        <div className="bg-white w-full max-w-4xl h-[600px] rounded-xl shadow-inner border border-gray-200 flex flex-col">
          <div className="flex-grow p-6 overflow-y-auto">
            <div className="bg-blue-100 p-4 rounded-lg self-start max-w-[80%] mb-4">
              <p className="text-blue-900">Welcome to the <strong>{roomId}</strong> chat room!</p>
            </div>
            <div className="bg-gray-100 p-4 rounded-lg self-end max-w-[80%] ml-auto mb-4">
              <p className="text-gray-800">This is a demo chat interface for {roomId}.</p>
            </div>
          </div>

          <div className="p-4 border-t border-gray-200">
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Type your message..."
                className="flex-grow p-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button className="bg-blue-600 text-white px-6 py-2 rounded-lg font-semibold hover:bg-blue-700">
                Send
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default ChatRoom;
